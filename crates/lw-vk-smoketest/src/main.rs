//! Headless smoke test for `VK_LAYER_LINUXWOLF_overlay`.
//!
//! Renders frames to a `VK_EXT_headless_surface` swapchain (works on Mesa's
//! lavapipe in CI/cloud without a GPU or display). Each frame first copies the
//! acquired image back to the CPU *before* clearing it: on Mesa headless the
//! image still holds what was last presented, so we can check that the layer
//! drew the HUD into it. Then it clears the image and presents.
//!
//! Exit code 0 = HUD pixels found in presented images.
//!
//! Run via `tools/smoketest.sh`, which points the Vulkan loader at the layer.

use ash::{ext, khr, vk};
use std::ffi::CStr;

const FRAMES: u32 = 30;
const CLEAR: [f32; 4] = [0.25, 0.0, 0.25, 1.0];
// Must match crates/lw-overlay-layer/src/hud.rs
const HUD_X: u32 = 16;
const HUD_Y: u32 = 16;
const HUD_ACCENT: [u8; 3] = [0x4c, 0xc9, 0xf0];
const HUD_BG: [u8; 3] = [0x12, 0x16, 0x20];

fn main() {
    unsafe { run() }
}

unsafe fn run() {
    let entry = ash::Entry::load().expect("Vulkan loader not found");
    let layers = entry.enumerate_instance_layer_properties().unwrap();
    let layer_present = layers
        .iter()
        .any(|l| CStr::from_ptr(l.layer_name.as_ptr()).to_bytes() == b"VK_LAYER_LINUXWOLF_overlay");
    println!("layer visible to loader: {layer_present}");

    let app = vk::ApplicationInfo::default().api_version(vk::API_VERSION_1_1);
    let exts = [khr::surface::NAME.as_ptr(), ext::headless_surface::NAME.as_ptr()];
    let instance = entry
        .create_instance(&vk::InstanceCreateInfo::default().application_info(&app).enabled_extension_names(&exts), None)
        .expect("create instance");
    let surface_fn = khr::surface::Instance::new(&entry, &instance);
    let headless = ext::headless_surface::Instance::new(&entry, &instance);
    let surface = headless.create_headless_surface(&vk::HeadlessSurfaceCreateInfoEXT::default(), None).unwrap();

    let pd = instance.enumerate_physical_devices().unwrap()[0];
    let props = instance.get_physical_device_properties(pd);
    println!("device: {}", CStr::from_ptr(props.device_name.as_ptr()).to_string_lossy());
    let family = instance
        .get_physical_device_queue_family_properties(pd)
        .iter()
        .enumerate()
        .position(|(i, f)| {
            f.queue_flags.contains(vk::QueueFlags::GRAPHICS)
                && surface_fn.get_physical_device_surface_support(pd, i as u32, surface).unwrap_or(false)
        })
        .expect("no graphics+present queue") as u32;
    let prio = [1.0];
    let qci = [vk::DeviceQueueCreateInfo::default().queue_family_index(family).queue_priorities(&prio)];
    let dexts = [khr::swapchain::NAME.as_ptr()];
    let device = instance
        .create_device(pd, &vk::DeviceCreateInfo::default().queue_create_infos(&qci).enabled_extension_names(&dexts), None)
        .unwrap();
    let queue = device.get_device_queue(family, 0);
    let swapchain_fn = khr::swapchain::Device::new(&instance, &device);

    let caps = surface_fn.get_physical_device_surface_capabilities(pd, surface).unwrap();
    let formats = surface_fn.get_physical_device_surface_formats(pd, surface).unwrap();
    let format = formats
        .iter()
        .find(|f| f.format == vk::Format::B8G8R8A8_UNORM)
        .or_else(|| formats.first())
        .copied()
        .unwrap();
    let extent = if caps.current_extent.width == u32::MAX {
        vk::Extent2D { width: 640, height: 360 }
    } else {
        caps.current_extent
    };
    let swapchain = swapchain_fn
        .create_swapchain(
            &vk::SwapchainCreateInfoKHR::default()
                .surface(surface)
                .min_image_count(caps.min_image_count.max(2))
                .image_format(format.format)
                .image_color_space(format.color_space)
                .image_extent(extent)
                .image_array_layers(1)
                .image_usage(vk::ImageUsageFlags::TRANSFER_DST | vk::ImageUsageFlags::TRANSFER_SRC)
                .pre_transform(caps.current_transform)
                .composite_alpha(vk::CompositeAlphaFlagsKHR::OPAQUE)
                .present_mode(vk::PresentModeKHR::FIFO)
                .clipped(true),
            None,
        )
        .unwrap();
    let images = swapchain_fn.get_swapchain_images(swapchain).unwrap();
    println!("swapchain {}x{} {:?}, {} images", extent.width, extent.height, format.format, images.len());

    // Readback buffer for a whole image.
    let size = (extent.width * extent.height * 4) as u64;
    let buffer = device
        .create_buffer(&vk::BufferCreateInfo::default().size(size).usage(vk::BufferUsageFlags::TRANSFER_DST), None)
        .unwrap();
    let req = device.get_buffer_memory_requirements(buffer);
    let mem_props = instance.get_physical_device_memory_properties(pd);
    let mem_type = (0..mem_props.memory_type_count)
        .find(|i| {
            req.memory_type_bits & (1 << i) != 0
                && mem_props.memory_types[*i as usize]
                    .property_flags
                    .contains(vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT)
        })
        .unwrap();
    let memory = device
        .allocate_memory(&vk::MemoryAllocateInfo::default().allocation_size(req.size).memory_type_index(mem_type), None)
        .unwrap();
    device.bind_buffer_memory(buffer, memory, 0).unwrap();
    let mapped = device.map_memory(memory, 0, size, vk::MemoryMapFlags::empty()).unwrap() as *const u8;

    let pool = device
        .create_command_pool(
            &vk::CommandPoolCreateInfo::default()
                .queue_family_index(family)
                .flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER),
            None,
        )
        .unwrap();
    let cmd = device
        .allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(pool).command_buffer_count(1))
        .unwrap()[0];
    let fence = device.create_fence(&vk::FenceCreateInfo::default(), None).unwrap();
    let acquire_fence = device.create_fence(&vk::FenceCreateInfo::default(), None).unwrap();
    let render_sems: Vec<_> = images
        .iter()
        .map(|_| device.create_semaphore(&vk::SemaphoreCreateInfo::default(), None).unwrap())
        .collect();
    let mut presented = vec![false; images.len()];
    let range = vk::ImageSubresourceRange::default().aspect_mask(vk::ImageAspectFlags::COLOR).level_count(1).layer_count(1);
    let barrier = |image, old, new, src, dst| {
        vk::ImageMemoryBarrier::default()
            .image(image)
            .old_layout(old)
            .new_layout(new)
            .src_access_mask(src)
            .dst_access_mask(dst)
            .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
            .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
            .subresource_range(range)
    };

    let bgra = format.format == vk::Format::B8G8R8A8_UNORM || format.format == vk::Format::B8G8R8A8_SRGB;
    let pixel = |x: u32, y: u32| -> [u8; 3] {
        let i = ((y * extent.width + x) * 4) as usize;
        let p = std::slice::from_raw_parts(mapped.add(i), 4);
        if bgra { [p[2], p[1], p[0]] } else { [p[0], p[1], p[2]] }
    };

    // Frame export (crates/lw-overlay-layer/src/capture.rs): ask for a frame
    // halfway through, like a Linuxwolf app does.
    let exe = std::env::current_exe().unwrap();
    let key = exe.file_name().unwrap().to_string_lossy().to_lowercase();
    let cap_dir = std::path::Path::new("/dev/shm/linuxwolf-capture");
    let frame_file = cap_dir.join(format!("{key}.frame"));
    let _ = std::fs::remove_file(&frame_file);
    let mut last_outside = [0u8; 3];

    let mut checked = 0;
    let mut hud_seen = 0;
    for frame in 0..FRAMES {
        if frame == FRAMES / 2 {
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::create_dir_all(cap_dir).unwrap();
            std::fs::write(cap_dir.join(format!("{key}.req")), b"").unwrap();
        }
        if frame >= FRAMES / 2 && frame < FRAMES / 2 + 3 {
            // Let the layer's 100 ms request check come round.
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
        let (idx, _) = swapchain_fn.acquire_next_image(swapchain, u64::MAX, vk::Semaphore::null(), acquire_fence).unwrap();
        device.wait_for_fences(&[acquire_fence], true, u64::MAX).unwrap();
        device.reset_fences(&[acquire_fence]).unwrap();
        let image = images[idx as usize];
        let was_presented = presented[idx as usize];

        device.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default()).unwrap();
        let old = if was_presented { vk::ImageLayout::PRESENT_SRC_KHR } else { vk::ImageLayout::UNDEFINED };
        if was_presented {
            let b = barrier(image, old, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, vk::AccessFlags::empty(), vk::AccessFlags::TRANSFER_READ);
            device.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER, vk::DependencyFlags::empty(), &[], &[], &[b]);
            let region = vk::BufferImageCopy::default()
                .image_subresource(vk::ImageSubresourceLayers::default().aspect_mask(vk::ImageAspectFlags::COLOR).layer_count(1))
                .image_extent(vk::Extent3D { width: extent.width, height: extent.height, depth: 1 });
            device.cmd_copy_image_to_buffer(cmd, image, vk::ImageLayout::TRANSFER_SRC_OPTIMAL, buffer, &[region]);
        }
        let from = if was_presented { vk::ImageLayout::TRANSFER_SRC_OPTIMAL } else { vk::ImageLayout::UNDEFINED };
        let b = barrier(image, from, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::AccessFlags::TRANSFER_READ, vk::AccessFlags::TRANSFER_WRITE);
        device.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::TRANSFER, vk::DependencyFlags::empty(), &[], &[], &[b]);
        device.cmd_clear_color_image(cmd, image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &vk::ClearColorValue { float32: CLEAR }, &[range]);
        let b = barrier(image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::PRESENT_SRC_KHR, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::empty());
        device.cmd_pipeline_barrier(cmd, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::BOTTOM_OF_PIPE, vk::DependencyFlags::empty(), &[], &[], &[b]);
        device.end_command_buffer(cmd).unwrap();

        let sem = [render_sems[idx as usize]];
        let cmds = [cmd];
        let submit = vk::SubmitInfo::default().command_buffers(&cmds).signal_semaphores(&sem);
        device.queue_submit(queue, &[submit], fence).unwrap();
        device.wait_for_fences(&[fence], true, u64::MAX).unwrap();
        device.reset_fences(&[fence]).unwrap();

        if was_presented {
            checked += 1;
            let border = pixel(HUD_X, HUD_Y);
            let inside = pixel(HUD_X + 200, HUD_Y + 40);
            let outside = pixel(extent.width - 10, extent.height - 10);
            last_outside = outside;
            let hud_ok = border == HUD_ACCENT && inside == HUD_BG;
            if hud_ok {
                hud_seen += 1;
            }
            if frame < 6 || !hud_ok {
                println!("frame {frame}: image {idx} border {border:02x?} inside {inside:02x?} outside {outside:02x?} hud={hud_ok}");
            }
        }

        let scs = [swapchain];
        let idxs = [idx];
        swapchain_fn
            .queue_present(queue, &vk::PresentInfoKHR::default().wait_semaphores(&sem).swapchains(&scs).image_indices(&idxs))
            .unwrap();
        presented[idx as usize] = true;
    }
    device.device_wait_idle().unwrap();

    // Write the last presented frame as a PPM for a visual check.
    if let Ok(path) = std::env::var("LW_SMOKETEST_PPM") {
        let mut out = format!("P6\n{} {}\n255\n", extent.width, extent.height).into_bytes();
        for y in 0..extent.height {
            for x in 0..extent.width {
                out.extend_from_slice(&pixel(x, y));
            }
        }
        std::fs::write(&path, out).unwrap();
        println!("wrote {path}");
    }

    println!("checked {checked} presented images, HUD found in {hud_seen}");

    // The exported frame must be the presented image: clear colour and HUD.
    let export_ok = match std::fs::read(&frame_file) {
        Ok(data) if data.len() >= 24 && &data[..8] == b"LWFRAME1" => {
            let u = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
            let (w, h, rgba) = (u(8), u(12), u(16) == 1);
            let px = |x: u32, y: u32| -> [u8; 3] {
                let i = 24 + ((y * w + x) * 4) as usize;
                let p = &data[i..i + 4];
                if rgba { [p[0], p[1], p[2]] } else { [p[2], p[1], p[0]] }
            };
            let ok = w == extent.width
                && h == extent.height
                && data.len() == 24 + (w * h * 4) as usize
                && px(w - 10, h - 10) == last_outside
                && px(HUD_X, HUD_Y) == HUD_ACCENT;
            println!("exported frame {w}x{h} rgba={rgba}: outside {:02x?} hud {:02x?} ok={ok}", px(w - 10, h - 10), px(HUD_X, HUD_Y));
            ok
        }
        _ => {
            println!("no exported frame at {}", frame_file.display());
            false
        }
    };
    device.destroy_swapchain_khr_cleanup(&swapchain_fn, swapchain);
    std::process::exit(if checked > 0 && hud_seen == checked && export_ok { 0 } else { 1 });
}

trait Cleanup {
    unsafe fn destroy_swapchain_khr_cleanup(&self, f: &khr::swapchain::Device, sc: vk::SwapchainKHR);
}
impl Cleanup for ash::Device {
    unsafe fn destroy_swapchain_khr_cleanup(&self, f: &khr::swapchain::Device, sc: vk::SwapchainKHR) {
        // Exercises the layer's vkDestroySwapchainKHR path.
        f.destroy_swapchain(sc, None);
    }
}
