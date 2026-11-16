//! `VK_LAYER_LINUXWOLF_overlay`: a Vulkan layer that draws the Linuxwolf
//! overlay directly into a game's swapchain images right before present.
//!
//! Why a Vulkan layer: under Proton, DXVK (D3D9-11) and VKD3D-Proton (D3D12)
//! translate the game's DirectX calls to Vulkan, so every Proton game ends up
//! presenting through `vkQueuePresentKHR` on the Linux side. Hooking there
//! works without touching the Windows side of the game (no DLL injection, no
//! DirectX hooks) and without compositor support, which matters on Wayland
//! where a client cannot place an always-on-top window over a fullscreen
//! game. MangoHud uses the same approach.
//!
//! Drawing path (spike version): the HUD is a CPU-side BGRA/RGBA bitmap in a
//! host-visible buffer that is copied into a rectangle of the swapchain image
//! with `vkCmdCopyBufferToImage`. That needs `TRANSFER_DST` usage on the
//! swapchain, which the layer adds in `vkCreateSwapchainKHR`. In step 2 the
//! bitmap comes from the Overwolf app renderer (CEF offscreen) instead, and
//! later a blend pass replaces the plain copy to get transparency.
//!
//! Enable per game with the Steam launch option
//! `LINUXWOLF_OVERLAY=1 %command%`.

#![allow(clippy::missing_safety_doc, clippy::missing_transmute_annotations, non_snake_case)]
// Spike: most Vulkan results on the hot path are best effort; failures fall
// back to presenting without the overlay.
#![allow(unused_must_use)]

mod font;
pub mod hud;

use ash::vk::{self, Handle};
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::mem::transmute;
use std::ptr;
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

// ---------------------------------------------------------------------------
// Loader <-> layer interface (vk_layer.h), not part of ash.
// ---------------------------------------------------------------------------

const LAYER_NEGOTIATE_INTERFACE_STRUCT: u32 = 1;
const STRUCTURE_TYPE_LOADER_INSTANCE_CREATE_INFO: i32 = 47;
const STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO: i32 = 48;
const LAYER_LINK_INFO: u32 = 0;
const LOADER_DATA_CALLBACK: u32 = 1;

type PfnSetDeviceLoaderData = unsafe extern "system" fn(vk::Device, *mut c_void) -> vk::Result;

#[repr(C)]
pub struct NegotiateLayerInterface {
    s_type: u32,
    p_next: *mut c_void,
    loader_layer_interface_version: u32,
    pfn_get_instance_proc_addr: Option<vk::PFN_vkGetInstanceProcAddr>,
    pfn_get_device_proc_addr: Option<vk::PFN_vkGetDeviceProcAddr>,
    pfn_get_physical_device_proc_addr: Option<unsafe extern "system" fn()>,
}

#[repr(C)]
struct LayerInstanceLink {
    p_next: *mut LayerInstanceLink,
    pfn_next_get_instance_proc_addr: vk::PFN_vkGetInstanceProcAddr,
    pfn_next_get_physical_device_proc_addr: Option<unsafe extern "system" fn()>,
}

#[repr(C)]
struct LayerInstanceCreateInfo {
    s_type: i32,
    p_next: *const c_void,
    function: u32,
    u: *mut c_void, // union; we only use the LayerInstanceLink* member
}

#[repr(C)]
struct LayerDeviceLink {
    p_next: *mut LayerDeviceLink,
    pfn_next_get_instance_proc_addr: vk::PFN_vkGetInstanceProcAddr,
    pfn_next_get_device_proc_addr: vk::PFN_vkGetDeviceProcAddr,
}

#[repr(C)]
struct LayerDeviceCreateInfo {
    s_type: i32,
    p_next: *const c_void,
    function: u32,
    u: *mut c_void, // LayerDeviceLink* or PFN_vkSetDeviceLoaderData
}

#[repr(C)]
struct BaseIn {
    s_type: i32,
    p_next: *const c_void,
}

unsafe fn find_in_chain(mut p: *const c_void, s_type: i32, function: u32) -> *mut c_void {
    while !p.is_null() {
        let base = p as *const BaseIn;
        if (*base).s_type == s_type {
            // Instance and device variants share the same prefix layout.
            let info = p as *const LayerDeviceCreateInfo;
            if (*info).function == function {
                return p as *mut c_void;
            }
        }
        p = (*base).p_next;
    }
    ptr::null_mut()
}

/// Dispatchable handles start with a pointer to the loader's dispatch table;
/// all handles of one instance/device share it, so it is the lookup key.
unsafe fn dispatch_key<H: Handle>(h: H) -> usize {
    *(h.as_raw() as usize as *const usize)
}

macro_rules! load {
    ($gpa:expr, $handle:expr, $name:literal) => {
        transmute::<vk::PFN_vkVoidFunction, _>(($gpa)($handle, concat!($name, "\0").as_ptr() as *const c_char))
    };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct InstanceData {
    instance: vk::Instance,
    gipa: vk::PFN_vkGetInstanceProcAddr,
    destroy_instance: vk::PFN_vkDestroyInstance,
    get_memory_properties: vk::PFN_vkGetPhysicalDeviceMemoryProperties,
    get_queue_family_properties: vk::PFN_vkGetPhysicalDeviceQueueFamilyProperties,
    get_surface_capabilities: Option<vk::PFN_vkGetPhysicalDeviceSurfaceCapabilitiesKHR>,
}

struct DeviceFns {
    destroy_device: vk::PFN_vkDestroyDevice,
    device_wait_idle: vk::PFN_vkDeviceWaitIdle,
    get_device_queue: vk::PFN_vkGetDeviceQueue,
    get_device_queue2: Option<vk::PFN_vkGetDeviceQueue2>,
    create_swapchain: vk::PFN_vkCreateSwapchainKHR,
    destroy_swapchain: vk::PFN_vkDestroySwapchainKHR,
    get_swapchain_images: vk::PFN_vkGetSwapchainImagesKHR,
    queue_present: vk::PFN_vkQueuePresentKHR,
    queue_submit: vk::PFN_vkQueueSubmit,
    create_command_pool: vk::PFN_vkCreateCommandPool,
    destroy_command_pool: vk::PFN_vkDestroyCommandPool,
    allocate_command_buffers: vk::PFN_vkAllocateCommandBuffers,
    free_command_buffers: vk::PFN_vkFreeCommandBuffers,
    begin_command_buffer: vk::PFN_vkBeginCommandBuffer,
    end_command_buffer: vk::PFN_vkEndCommandBuffer,
    reset_command_buffer: vk::PFN_vkResetCommandBuffer,
    cmd_pipeline_barrier: vk::PFN_vkCmdPipelineBarrier,
    cmd_copy_buffer_to_image: vk::PFN_vkCmdCopyBufferToImage,
    create_fence: vk::PFN_vkCreateFence,
    destroy_fence: vk::PFN_vkDestroyFence,
    wait_for_fences: vk::PFN_vkWaitForFences,
    reset_fences: vk::PFN_vkResetFences,
    create_semaphore: vk::PFN_vkCreateSemaphore,
    destroy_semaphore: vk::PFN_vkDestroySemaphore,
    create_buffer: vk::PFN_vkCreateBuffer,
    destroy_buffer: vk::PFN_vkDestroyBuffer,
    get_buffer_memory_requirements: vk::PFN_vkGetBufferMemoryRequirements,
    allocate_memory: vk::PFN_vkAllocateMemory,
    free_memory: vk::PFN_vkFreeMemory,
    bind_buffer_memory: vk::PFN_vkBindBufferMemory,
    map_memory: vk::PFN_vkMapMemory,
}

struct DeviceData {
    device: vk::Device,
    instance_key: usize,
    physical_device: vk::PhysicalDevice,
    gdpa: vk::PFN_vkGetDeviceProcAddr,
    set_loader_data: Option<PfnSetDeviceLoaderData>,
    memory_properties: vk::PhysicalDeviceMemoryProperties,
    queue_family_flags: Vec<vk::QueueFlags>,
    fns: DeviceFns,
    pools: HashMap<u32, vk::CommandPool>,
}

struct Slot {
    family: u32,
    cmd: vk::CommandBuffer,
    fence: vk::Fence,
    semaphore: vk::Semaphore,
    buffer: vk::Buffer,
    memory: vk::DeviceMemory,
    mapped: *mut u8,
}

struct SwapchainData {
    device_key: usize,
    images: Vec<vk::Image>,
    extent: vk::Extent2D,
    order: Option<hud::PixelOrder>,
    slots: Vec<Option<Slot>>,
    frames: u64,
    fps: f32,
    fps_window_start: Instant,
    fps_window_frames: u32,
}

#[derive(Default)]
struct State {
    instances: HashMap<usize, InstanceData>,
    devices: HashMap<usize, DeviceData>,
    /// queue handle -> (device key, queue family)
    queues: HashMap<u64, (usize, u32)>,
    swapchains: HashMap<u64, SwapchainData>,
}

// Raw pointers in Slot are only touched while holding the lock.
unsafe impl Send for State {}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn state() -> MutexGuard<'static, Option<State>> {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = Some(State::default());
    }
    g
}

fn log(msg: &str) {
    if std::env::var_os("LINUXWOLF_OVERLAY_DEBUG").is_some() {
        eprintln!("[linuxwolf-overlay] {msg}");
    }
}

/// Text shown in the HUD's second line: the Steam app id under Proton, or
/// the process name otherwise.
fn game_label() -> String {
    for k in ["SteamAppId", "SteamGameId", "STEAM_COMPAT_APP_ID"] {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() && v != "0" {
                return format!("STEAM APP {v}");
            }
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "UNKNOWN".into())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "system" fn vkNegotiateLoaderLayerInterfaceVersion(
    p: *mut NegotiateLayerInterface,
) -> vk::Result {
    if p.is_null() || (*p).s_type != LAYER_NEGOTIATE_INTERFACE_STRUCT {
        return vk::Result::ERROR_INITIALIZATION_FAILED;
    }
    if (*p).loader_layer_interface_version < 2 {
        return vk::Result::ERROR_INITIALIZATION_FAILED;
    }
    (*p).loader_layer_interface_version = 2;
    (*p).pfn_get_instance_proc_addr = Some(get_instance_proc_addr);
    (*p).pfn_get_device_proc_addr = Some(get_device_proc_addr);
    (*p).pfn_get_physical_device_proc_addr = None;
    vk::Result::SUCCESS
}

unsafe fn intercept(name: &CStr) -> vk::PFN_vkVoidFunction {
    let f: *const c_void = match name.to_bytes() {
        b"vkGetInstanceProcAddr" => get_instance_proc_addr as *const c_void,
        b"vkGetDeviceProcAddr" => get_device_proc_addr as *const c_void,
        b"vkCreateInstance" => create_instance as *const c_void,
        b"vkDestroyInstance" => destroy_instance as *const c_void,
        b"vkCreateDevice" => create_device as *const c_void,
        b"vkDestroyDevice" => destroy_device as *const c_void,
        b"vkGetDeviceQueue" => get_device_queue as *const c_void,
        b"vkGetDeviceQueue2" => get_device_queue2 as *const c_void,
        b"vkCreateSwapchainKHR" => create_swapchain as *const c_void,
        b"vkDestroySwapchainKHR" => destroy_swapchain as *const c_void,
        b"vkQueuePresentKHR" => queue_present as *const c_void,
        _ => return None,
    };
    transmute::<*const c_void, vk::PFN_vkVoidFunction>(f)
}

unsafe extern "system" fn get_instance_proc_addr(
    instance: vk::Instance,
    name: *const c_char,
) -> vk::PFN_vkVoidFunction {
    let cname = CStr::from_ptr(name);
    if let Some(f) = intercept(cname) {
        return Some(f);
    }
    if instance == vk::Instance::null() {
        return None;
    }
    let gipa = {
        let g = state();
        match g.as_ref().unwrap().instances.get(&dispatch_key(instance)) {
            Some(i) => i.gipa,
            None => return None,
        }
    };
    gipa(instance, name)
}

unsafe extern "system" fn get_device_proc_addr(
    device: vk::Device,
    name: *const c_char,
) -> vk::PFN_vkVoidFunction {
    let cname = CStr::from_ptr(name);
    let gdpa = {
        let g = state();
        match g.as_ref().unwrap().devices.get(&dispatch_key(device)) {
            Some(d) => d.gdpa,
            None => return None,
        }
    };
    // Only hand out our hooks for functions the next layer actually has
    // (e.g. vkCreateSwapchainKHR only if VK_KHR_swapchain was enabled).
    if let Some(f) = intercept(cname) {
        if gdpa(device, name).is_some() || matches!(cname.to_bytes(), b"vkGetDeviceProcAddr") {
            return Some(f);
        }
        return None;
    }
    gdpa(device, name)
}

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

unsafe extern "system" fn create_instance(
    ci: *const vk::InstanceCreateInfo,
    alloc: *const vk::AllocationCallbacks,
    out: *mut vk::Instance,
) -> vk::Result {
    let link = find_in_chain((*ci).p_next, STRUCTURE_TYPE_LOADER_INSTANCE_CREATE_INFO, LAYER_LINK_INFO)
        as *mut LayerInstanceCreateInfo;
    if link.is_null() {
        return vk::Result::ERROR_INITIALIZATION_FAILED;
    }
    let layer_info = (*link).u as *mut LayerInstanceLink;
    let gipa = (*layer_info).pfn_next_get_instance_proc_addr;
    (*link).u = (*layer_info).p_next as *mut c_void;

    let next_create: Option<vk::PFN_vkCreateInstance> = load!(gipa, vk::Instance::null(), "vkCreateInstance");
    let Some(next_create) = next_create else {
        return vk::Result::ERROR_INITIALIZATION_FAILED;
    };
    let r = next_create(ci, alloc, out);
    if r != vk::Result::SUCCESS {
        return r;
    }
    let instance = *out;
    let data = InstanceData {
        instance,
        gipa,
        destroy_instance: load!(gipa, instance, "vkDestroyInstance"),
        get_memory_properties: load!(gipa, instance, "vkGetPhysicalDeviceMemoryProperties"),
        get_queue_family_properties: load!(gipa, instance, "vkGetPhysicalDeviceQueueFamilyProperties"),
        get_surface_capabilities: load!(gipa, instance, "vkGetPhysicalDeviceSurfaceCapabilitiesKHR"),
    };
    state().as_mut().unwrap().instances.insert(dispatch_key(instance), data);
    log("instance created");
    vk::Result::SUCCESS
}

unsafe extern "system" fn destroy_instance(instance: vk::Instance, alloc: *const vk::AllocationCallbacks) {
    let data = state().as_mut().unwrap().instances.remove(&dispatch_key(instance));
    if let Some(d) = data {
        (d.destroy_instance)(instance, alloc);
    }
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

unsafe extern "system" fn create_device(
    physical_device: vk::PhysicalDevice,
    ci: *const vk::DeviceCreateInfo,
    alloc: *const vk::AllocationCallbacks,
    out: *mut vk::Device,
) -> vk::Result {
    let link = find_in_chain((*ci).p_next, STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO, LAYER_LINK_INFO)
        as *mut LayerDeviceCreateInfo;
    if link.is_null() {
        return vk::Result::ERROR_INITIALIZATION_FAILED;
    }
    let loader_cb = find_in_chain((*ci).p_next, STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO, LOADER_DATA_CALLBACK)
        as *mut LayerDeviceCreateInfo;
    let set_loader_data: Option<PfnSetDeviceLoaderData> =
        if loader_cb.is_null() { None } else { transmute::<*mut c_void, Option<PfnSetDeviceLoaderData>>((*loader_cb).u) };

    let layer_info = (*link).u as *mut LayerDeviceLink;
    let gipa = (*layer_info).pfn_next_get_instance_proc_addr;
    let gdpa = (*layer_info).pfn_next_get_device_proc_addr;
    (*link).u = (*layer_info).p_next as *mut c_void;

    let instance_key = dispatch_key(physical_device);
    let (instance, get_mem, get_qf) = {
        let g = state();
        let Some(i) = g.as_ref().unwrap().instances.get(&instance_key) else {
            return vk::Result::ERROR_INITIALIZATION_FAILED;
        };
        (i.instance, i.get_memory_properties, i.get_queue_family_properties)
    };
    let next_create: Option<vk::PFN_vkCreateDevice> = load!(gipa, instance, "vkCreateDevice");
    let Some(next_create) = next_create else {
        return vk::Result::ERROR_INITIALIZATION_FAILED;
    };
    let r = next_create(physical_device, ci, alloc, out);
    if r != vk::Result::SUCCESS {
        return r;
    }
    let device = *out;

    let mut memory_properties = vk::PhysicalDeviceMemoryProperties::default();
    get_mem(physical_device, &mut memory_properties);
    let mut count = 0u32;
    get_qf(physical_device, &mut count, ptr::null_mut());
    let mut families = vec![vk::QueueFamilyProperties::default(); count as usize];
    get_qf(physical_device, &mut count, families.as_mut_ptr());

    let fns = DeviceFns {
        destroy_device: load!(gdpa, device, "vkDestroyDevice"),
        device_wait_idle: load!(gdpa, device, "vkDeviceWaitIdle"),
        get_device_queue: load!(gdpa, device, "vkGetDeviceQueue"),
        get_device_queue2: load!(gdpa, device, "vkGetDeviceQueue2"),
        create_swapchain: load!(gdpa, device, "vkCreateSwapchainKHR"),
        destroy_swapchain: load!(gdpa, device, "vkDestroySwapchainKHR"),
        get_swapchain_images: load!(gdpa, device, "vkGetSwapchainImagesKHR"),
        queue_present: load!(gdpa, device, "vkQueuePresentKHR"),
        queue_submit: load!(gdpa, device, "vkQueueSubmit"),
        create_command_pool: load!(gdpa, device, "vkCreateCommandPool"),
        destroy_command_pool: load!(gdpa, device, "vkDestroyCommandPool"),
        allocate_command_buffers: load!(gdpa, device, "vkAllocateCommandBuffers"),
        free_command_buffers: load!(gdpa, device, "vkFreeCommandBuffers"),
        begin_command_buffer: load!(gdpa, device, "vkBeginCommandBuffer"),
        end_command_buffer: load!(gdpa, device, "vkEndCommandBuffer"),
        reset_command_buffer: load!(gdpa, device, "vkResetCommandBuffer"),
        cmd_pipeline_barrier: load!(gdpa, device, "vkCmdPipelineBarrier"),
        cmd_copy_buffer_to_image: load!(gdpa, device, "vkCmdCopyBufferToImage"),
        create_fence: load!(gdpa, device, "vkCreateFence"),
        destroy_fence: load!(gdpa, device, "vkDestroyFence"),
        wait_for_fences: load!(gdpa, device, "vkWaitForFences"),
        reset_fences: load!(gdpa, device, "vkResetFences"),
        create_semaphore: load!(gdpa, device, "vkCreateSemaphore"),
        destroy_semaphore: load!(gdpa, device, "vkDestroySemaphore"),
        create_buffer: load!(gdpa, device, "vkCreateBuffer"),
        destroy_buffer: load!(gdpa, device, "vkDestroyBuffer"),
        get_buffer_memory_requirements: load!(gdpa, device, "vkGetBufferMemoryRequirements"),
        allocate_memory: load!(gdpa, device, "vkAllocateMemory"),
        free_memory: load!(gdpa, device, "vkFreeMemory"),
        bind_buffer_memory: load!(gdpa, device, "vkBindBufferMemory"),
        map_memory: load!(gdpa, device, "vkMapMemory"),
    };
    let data = DeviceData {
        device,
        instance_key,
        physical_device,
        gdpa,
        set_loader_data,
        memory_properties,
        queue_family_flags: families.iter().map(|f| f.queue_flags).collect(),
        fns,
        pools: HashMap::new(),
    };
    state().as_mut().unwrap().devices.insert(dispatch_key(device), data);
    log("device created");
    vk::Result::SUCCESS
}

unsafe extern "system" fn destroy_device(device: vk::Device, alloc: *const vk::AllocationCallbacks) {
    let key = dispatch_key(device);
    let mut g = state();
    let st = g.as_mut().unwrap();
    let Some(mut dev) = st.devices.remove(&key) else {
        return;
    };
    (dev.fns.device_wait_idle)(device);
    let owned: Vec<u64> = st.swapchains.iter().filter(|(_, s)| s.device_key == key).map(|(k, _)| *k).collect();
    for k in owned {
        if let Some(mut sc) = st.swapchains.remove(&k) {
            free_slots(&dev, &mut sc);
        }
    }
    for (_, pool) in dev.pools.drain() {
        (dev.fns.destroy_command_pool)(device, pool, ptr::null());
    }
    st.queues.retain(|_, (k, _)| *k != key);
    let destroy = dev.fns.destroy_device;
    drop(g);
    destroy(device, alloc);
}

unsafe extern "system" fn get_device_queue(device: vk::Device, family: u32, index: u32, out: *mut vk::Queue) {
    let mut g = state();
    let st = g.as_mut().unwrap();
    let key = dispatch_key(device);
    let Some(dev) = st.devices.get(&key) else {
        return;
    };
    (dev.fns.get_device_queue)(device, family, index, out);
    if !(*out).is_null() {
        st.queues.insert((*out).as_raw(), (key, family));
    }
}

unsafe extern "system" fn get_device_queue2(
    device: vk::Device,
    info: *const vk::DeviceQueueInfo2,
    out: *mut vk::Queue,
) {
    let mut g = state();
    let st = g.as_mut().unwrap();
    let key = dispatch_key(device);
    let Some(f) = st.devices.get(&key).and_then(|d| d.fns.get_device_queue2) else {
        return;
    };
    f(device, info, out);
    if !(*out).is_null() {
        st.queues.insert((*out).as_raw(), (key, (*info).queue_family_index));
    }
}

// ---------------------------------------------------------------------------
// Swapchain
// ---------------------------------------------------------------------------

fn pixel_order(format: vk::Format) -> Option<hud::PixelOrder> {
    use vk::Format as F;
    match format {
        F::B8G8R8A8_UNORM | F::B8G8R8A8_SRGB => Some(hud::PixelOrder::Bgra),
        F::R8G8B8A8_UNORM | F::R8G8B8A8_SRGB => Some(hud::PixelOrder::Rgba),
        // HDR / 10-bit swapchains are left alone for now.
        _ => None,
    }
}

unsafe extern "system" fn create_swapchain(
    device: vk::Device,
    ci: *const vk::SwapchainCreateInfoKHR,
    alloc: *const vk::AllocationCallbacks,
    out: *mut vk::SwapchainKHR,
) -> vk::Result {
    let key = dispatch_key(device);
    let mut g = state();
    let st = g.as_mut().unwrap();
    let Some(dev) = st.devices.get(&key) else {
        return vk::Result::ERROR_INITIALIZATION_FAILED;
    };
    let mut info = *ci;
    let mut can_draw = pixel_order(info.image_format).is_some();
    if can_draw {
        let caps_fn = st.instances.get(&dev.instance_key).and_then(|i| i.get_surface_capabilities);
        let mut caps = vk::SurfaceCapabilitiesKHR::default();
        let supported = match caps_fn {
            Some(f) => {
                f(dev.physical_device, info.surface, &mut caps) == vk::Result::SUCCESS
                    && caps.supported_usage_flags.contains(vk::ImageUsageFlags::TRANSFER_DST)
            }
            None => false,
        };
        if supported {
            info.image_usage |= vk::ImageUsageFlags::TRANSFER_DST;
        } else {
            can_draw = false;
        }
    }
    let r = (dev.fns.create_swapchain)(device, &info, alloc, out);
    if r != vk::Result::SUCCESS {
        return r;
    }
    let mut count = 0u32;
    (dev.fns.get_swapchain_images)(device, *out, &mut count, ptr::null_mut());
    let mut images = vec![vk::Image::null(); count as usize];
    (dev.fns.get_swapchain_images)(device, *out, &mut count, images.as_mut_ptr());
    log(&format!(
        "swapchain {}x{} {:?}, {} images, overlay {}",
        info.image_extent.width,
        info.image_extent.height,
        info.image_format,
        count,
        if can_draw { "on" } else { "off (unsupported format or usage)" }
    ));
    st.swapchains.insert(
        (*out).as_raw(),
        SwapchainData {
            device_key: key,
            slots: (0..images.len()).map(|_| None).collect(),
            images,
            extent: info.image_extent,
            order: if can_draw { pixel_order(info.image_format) } else { None },
            frames: 0,
            fps: 0.0,
            fps_window_start: Instant::now(),
            fps_window_frames: 0,
        },
    );
    vk::Result::SUCCESS
}

unsafe fn free_slot(dev: &DeviceData, slot: Slot) {
    let d = dev.device;
    (dev.fns.wait_for_fences)(d, 1, &slot.fence, vk::TRUE, u64::MAX);
    if let Some(pool) = dev.pools.get(&slot.family) {
        (dev.fns.free_command_buffers)(d, *pool, 1, &slot.cmd);
    }
    (dev.fns.destroy_fence)(d, slot.fence, ptr::null());
    (dev.fns.destroy_semaphore)(d, slot.semaphore, ptr::null());
    (dev.fns.destroy_buffer)(d, slot.buffer, ptr::null());
    (dev.fns.free_memory)(d, slot.memory, ptr::null());
}

unsafe fn free_slots(dev: &DeviceData, sc: &mut SwapchainData) {
    for slot in sc.slots.iter_mut().filter_map(Option::take) {
        free_slot(dev, slot);
    }
}

unsafe extern "system" fn destroy_swapchain(
    device: vk::Device,
    swapchain: vk::SwapchainKHR,
    alloc: *const vk::AllocationCallbacks,
) {
    let key = dispatch_key(device);
    let mut g = state();
    let st = g.as_mut().unwrap();
    let Some(dev) = st.devices.get(&key) else {
        return;
    };
    if let Some(mut sc) = st.swapchains.remove(&swapchain.as_raw()) {
        free_slots(dev, &mut sc);
    }
    (dev.fns.destroy_swapchain)(device, swapchain, alloc);
}

// ---------------------------------------------------------------------------
// Present: draw the HUD, then forward
// ---------------------------------------------------------------------------

unsafe fn find_memory_type(dev: &DeviceData, bits: u32, flags: vk::MemoryPropertyFlags) -> Option<u32> {
    let props = &dev.memory_properties;
    (0..props.memory_type_count)
        .find(|i| bits & (1 << i) != 0 && props.memory_types[*i as usize].property_flags.contains(flags))
}

unsafe fn create_slot(dev: &mut DeviceData, family: u32) -> Option<Slot> {
    let d = dev.device;
    let pool = match dev.pools.get(&family) {
        Some(p) => *p,
        None => {
            let info = vk::CommandPoolCreateInfo::default()
                .flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER)
                .queue_family_index(family);
            let mut pool = vk::CommandPool::null();
            if (dev.fns.create_command_pool)(d, &info, ptr::null(), &mut pool) != vk::Result::SUCCESS {
                return None;
            }
            dev.pools.insert(family, pool);
            pool
        }
    };
    let alloc_info = vk::CommandBufferAllocateInfo::default()
        .command_pool(pool)
        .level(vk::CommandBufferLevel::PRIMARY)
        .command_buffer_count(1);
    let mut cmd = vk::CommandBuffer::null();
    if (dev.fns.allocate_command_buffers)(d, &alloc_info, &mut cmd) != vk::Result::SUCCESS {
        return None;
    }
    // Command buffers we create are dispatchable objects the loader never saw.
    match dev.set_loader_data {
        Some(f) => {
            f(d, cmd.as_raw() as usize as *mut c_void);
        }
        None => *(cmd.as_raw() as usize as *mut usize) = dispatch_key(d),
    }

    let mut fence = vk::Fence::null();
    let fence_info = vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED);
    (dev.fns.create_fence)(d, &fence_info, ptr::null(), &mut fence);
    let mut semaphore = vk::Semaphore::null();
    (dev.fns.create_semaphore)(d, &vk::SemaphoreCreateInfo::default(), ptr::null(), &mut semaphore);

    let size = (hud::HUD_W * hud::HUD_H * 4) as u64;
    let buf_info = vk::BufferCreateInfo::default()
        .size(size)
        .usage(vk::BufferUsageFlags::TRANSFER_SRC)
        .sharing_mode(vk::SharingMode::EXCLUSIVE);
    let mut buffer = vk::Buffer::null();
    (dev.fns.create_buffer)(d, &buf_info, ptr::null(), &mut buffer);
    let mut req = vk::MemoryRequirements::default();
    (dev.fns.get_buffer_memory_requirements)(d, buffer, &mut req);
    let mem_type = find_memory_type(
        dev,
        req.memory_type_bits,
        vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
    )?;
    let mem_info = vk::MemoryAllocateInfo::default().allocation_size(req.size).memory_type_index(mem_type);
    let mut memory = vk::DeviceMemory::null();
    if (dev.fns.allocate_memory)(d, &mem_info, ptr::null(), &mut memory) != vk::Result::SUCCESS {
        return None;
    }
    (dev.fns.bind_buffer_memory)(d, buffer, memory, 0);
    let mut mapped: *mut c_void = ptr::null_mut();
    (dev.fns.map_memory)(d, memory, 0, size, vk::MemoryMapFlags::empty(), &mut mapped);
    Some(Slot { family, cmd, fence, semaphore, buffer, memory, mapped: mapped as *mut u8 })
}

/// Records and submits the HUD copy for one swapchain image. Returns the
/// semaphore the present must wait on instead of the app's semaphores.
unsafe fn draw_hud(
    dev: &mut DeviceData,
    sc: &mut SwapchainData,
    queue: vk::Queue,
    family: u32,
    image_index: u32,
    wait: &[vk::Semaphore],
) -> Option<vk::Semaphore> {
    let order = sc.order?;
    let flags = *dev.queue_family_flags.get(family as usize)?;
    if !flags.intersects(vk::QueueFlags::GRAPHICS | vk::QueueFlags::COMPUTE | vk::QueueFlags::TRANSFER) {
        return None;
    }
    let image = *sc.images.get(image_index as usize)?;
    let idx = image_index as usize;
    if sc.slots[idx].as_ref().is_some_and(|s| s.family != family) {
        // Presented from another queue family than last time: rebuild.
        free_slot(dev, sc.slots[idx].take().unwrap());
    }
    if sc.slots[idx].is_none() {
        sc.slots[idx] = Some(create_slot(dev, family)?);
    }
    let slot = sc.slots[idx].as_ref().unwrap();
    let d = dev.device;
    let f = &dev.fns;
    (f.wait_for_fences)(d, 1, &slot.fence, vk::TRUE, u64::MAX);
    (f.reset_fences)(d, 1, &slot.fence);

    // FPS and HUD contents.
    sc.frames += 1;
    sc.fps_window_frames += 1;
    let elapsed = sc.fps_window_start.elapsed().as_secs_f32();
    if elapsed >= 0.5 {
        sc.fps = sc.fps_window_frames as f32 / elapsed;
        sc.fps_window_frames = 0;
        sc.fps_window_start = Instant::now();
    }
    let line2 = game_label();
    let line3 = format!("FPS {:>5.1}  FRAME {}", sc.fps, sc.frames);
    let pixels = std::slice::from_raw_parts_mut(slot.mapped, (hud::HUD_W * hud::HUD_H * 4) as usize);
    hud::render(
        pixels,
        order,
        &hud::Frame { lines: ["LINUXWOLF OVERLAY", &line2, &line3], phase: (sc.frames % 120) as f32 / 119.0 },
    );

    // Clamp the HUD rectangle to the swapchain extent.
    let w = (hud::HUD_W as i32).min(sc.extent.width as i32 - hud::HUD_X);
    let h = (hud::HUD_H as i32).min(sc.extent.height as i32 - hud::HUD_Y);
    if w <= 0 || h <= 0 {
        return None;
    }

    let cmd = slot.cmd;
    (f.reset_command_buffer)(cmd, vk::CommandBufferResetFlags::empty());
    let begin = vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT);
    (f.begin_command_buffer)(cmd, &begin);
    let range = vk::ImageSubresourceRange::default()
        .aspect_mask(vk::ImageAspectFlags::COLOR)
        .level_count(1)
        .layer_count(1);
    let to_dst = vk::ImageMemoryBarrier::default()
        .src_access_mask(vk::AccessFlags::empty())
        .dst_access_mask(vk::AccessFlags::TRANSFER_WRITE)
        .old_layout(vk::ImageLayout::PRESENT_SRC_KHR)
        .new_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
        .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
        .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
        .image(image)
        .subresource_range(range);
    (f.cmd_pipeline_barrier)(
        cmd,
        vk::PipelineStageFlags::TRANSFER,
        vk::PipelineStageFlags::TRANSFER,
        vk::DependencyFlags::empty(),
        0,
        ptr::null(),
        0,
        ptr::null(),
        1,
        &to_dst,
    );
    let region = vk::BufferImageCopy::default()
        .buffer_offset(0)
        .buffer_row_length(hud::HUD_W)
        .buffer_image_height(hud::HUD_H)
        .image_subresource(
            vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).layer_count(1),
        )
        .image_offset(vk::Offset3D { x: hud::HUD_X, y: hud::HUD_Y, z: 0 })
        .image_extent(vk::Extent3D { width: w as u32, height: h as u32, depth: 1 });
    (f.cmd_copy_buffer_to_image)(cmd, slot.buffer, image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, 1, &region);
    let to_present = vk::ImageMemoryBarrier::default()
        .src_access_mask(vk::AccessFlags::TRANSFER_WRITE)
        .dst_access_mask(vk::AccessFlags::empty())
        .old_layout(vk::ImageLayout::TRANSFER_DST_OPTIMAL)
        .new_layout(vk::ImageLayout::PRESENT_SRC_KHR)
        .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
        .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
        .image(image)
        .subresource_range(range);
    (f.cmd_pipeline_barrier)(
        cmd,
        vk::PipelineStageFlags::TRANSFER,
        vk::PipelineStageFlags::BOTTOM_OF_PIPE,
        vk::DependencyFlags::empty(),
        0,
        ptr::null(),
        0,
        ptr::null(),
        1,
        &to_present,
    );
    (f.end_command_buffer)(cmd);

    let stages = vec![vk::PipelineStageFlags::TRANSFER; wait.len()];
    let submit = vk::SubmitInfo {
        wait_semaphore_count: wait.len() as u32,
        p_wait_semaphores: wait.as_ptr(),
        p_wait_dst_stage_mask: stages.as_ptr(),
        command_buffer_count: 1,
        p_command_buffers: &cmd,
        signal_semaphore_count: 1,
        p_signal_semaphores: &slot.semaphore,
        ..Default::default()
    };
    if (f.queue_submit)(queue, 1, &submit, slot.fence) != vk::Result::SUCCESS {
        return None;
    }
    Some(slot.semaphore)
}

unsafe extern "system" fn queue_present(queue: vk::Queue, info: *const vk::PresentInfoKHR) -> vk::Result {
    let mut g = state();
    let st = g.as_mut().unwrap();
    let qkey = queue.as_raw();
    let (dev_key, family) = match st.queues.get(&qkey) {
        Some(v) => *v,
        None => (dispatch_key(queue), u32::MAX),
    };
    let Some(dev) = st.devices.get_mut(&dev_key) else {
        return vk::Result::ERROR_DEVICE_LOST;
    };
    let present = dev.fns.queue_present;
    let pi = &*info;
    let wait: &[vk::Semaphore] = if pi.wait_semaphore_count == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(pi.p_wait_semaphores, pi.wait_semaphore_count as usize)
    };

    let mut replacement = None;
    if family != u32::MAX {
        // Spike: draw on the first swapchain of the present (games use one).
        if pi.swapchain_count > 0 {
            let sc_handle = *pi.p_swapchains;
            let image_index = *pi.p_image_indices;
            if let Some(sc) = st.swapchains.get_mut(&sc_handle.as_raw()) {
                let dev = st.devices.get_mut(&dev_key).unwrap();
                replacement = draw_hud(dev, sc, queue, family, image_index, wait);
            }
        }
    }
    drop(g);

    match replacement {
        Some(sem) => {
            let mut patched = *pi;
            patched.wait_semaphore_count = 1;
            patched.p_wait_semaphores = &sem;
            present(queue, &patched)
        }
        None => present(queue, info),
    }
}
