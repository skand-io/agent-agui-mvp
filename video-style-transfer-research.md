# Video Style Transfer via Public APIs: Research Report

> Input: video frames + style prompt. Output: 60fps stylized video.
> Focus: publicly available APIs (Replicate, fal.ai, Runway, Kling, etc.)
> Compiled March 2026.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [The Core Pipeline](#the-core-pipeline)
3. [Part 1: Available APIs](#part-1-available-apis)
   - [Dedicated Video-to-Video APIs](#dedicated-video-to-video-apis)
   - [Frame-by-Frame img2img APIs](#frame-by-frame-img2img-apis)
   - [Video Foundation Models](#video-foundation-models)
4. [Part 2: The Flickering Problem & Temporal Consistency](#part-2-the-flickering-problem--temporal-consistency)
   - [Why Frame-by-Frame Flickers](#why-frame-by-frame-flickers)
   - [ControlNet for Structure](#controlnet-for-structure)
   - [IP-Adapter for Style Lock](#ip-adapter-for-style-lock)
   - [Optical Flow Warping](#optical-flow-warping)
   - [EbSynth Keyframe Propagation](#ebsynth-keyframe-propagation)
   - [Seed & Denoise Tuning](#seed--denoise-tuning)
5. [Part 3: The 60fps Pipeline](#part-3-the-60fps-pipeline)
   - [Frame Extraction](#frame-extraction)
   - [Frame Interpolation (RIFE/FILM)](#frame-interpolation-rifefilm)
   - [Audio Preservation](#audio-preservation)
   - [Batch Processing & Parallelization](#batch-processing--parallelization)
   - [End-to-End Architecture](#end-to-end-architecture)
6. [Part 4: Practical Recipes](#part-4-practical-recipes)
7. [Cost & Speed Comparison](#cost--speed-comparison)
8. [Recommended Approach](#recommended-approach)

---

## Executive Summary

**The best approach today:**

1. **Extract frames at 10-15fps** (not 30 or 60 — this is the key cost optimization)
2. **Style each frame** via API using SDXL img2img + ControlNet Depth + IP-Adapter + fixed seed at denoise 0.35-0.45
3. **Interpolate to 60fps** using RIFE (8x interpolation, then conform)
4. **Re-mux audio** from the original

**Alternatively**, for less engineering and better native consistency, use **Kling v2** or **Runway Gen-3** video-to-video APIs — they handle temporal consistency natively but give less fine-grained style control.

**Cost for a 30-second video:** $1.50-$18 depending on approach. Processing time: 3-10 minutes.

---

## The Core Pipeline

```
INPUT VIDEO (30s, 30fps, 1080p)
    │
    ├──[1] EXTRACT AUDIO ──────────────────────────────────────────┐
    │                                                               │
    ├──[2] EXTRACT FRAMES at 10-15fps (300-450 frames)             │
    │                                                               │
    ├──[3] EXTRACT CONTROLNET MAPS (depth/canny per frame)         │
    │                                                               │
    ├──[4] BATCH STYLE TRANSFER via API (20-50 concurrent)         │
    │      (img2img + ControlNet + IP-Adapter + fixed seed)        │
    │                                                               │
    ├──[5] REASSEMBLE at 10-15fps                                  │
    │                                                               │
    ├──[6] RIFE 8x INTERPOLATION → 80fps                          │
    │                                                               │
    ├──[7] CONFORM to 60fps                                        │
    │                                                               │
    └──[8] MUX AUDIO ◄─────────────────────────────────────────────┘
            │
            ▼
OUTPUT VIDEO (30s, 60fps, styled, with audio)
```

---

## Part 1: Available APIs

### Dedicated Video-to-Video APIs

These accept a source video + text prompt and output a re-stylized video with **native temporal consistency**.

| Platform | Model | Duration | Consistency | Cost/sec | API Endpoint |
|---|---|---|---|---|---|
| **Runway** | Gen-3 Alpha Turbo | 5-10s clips | Excellent | ~$0.05/s | `api.dev.runwayml.com/v1/` |
| **Runway** | Gen-4 | 5-10s clips | Excellent | ~$0.10-0.25/s | `api.dev.runwayml.com/v1/` |
| **Kling** | v2.0 | up to 10s | Very good | ~$0.014/s (std), $0.028/s (pro) | `api.klingai.com/` or via fal.ai |
| **fal.ai** | Kling v2 proxy | up to 10s | Very good | Slight markup over direct | `queue.fal.run/fal-ai/kling-video/v2/...` |
| **fal.ai** | Runway Gen-3 proxy | 5-10s | Excellent | Slight markup | `queue.fal.run/fal-ai/runway/gen3/...` |

**Pros:** Best temporal consistency (trained on video data), minimal engineering.
**Cons:** Limited stylistic control, fixed clip lengths (chain for longer videos), less customizable than per-frame.

### Frame-by-Frame img2img APIs

These process individual frames. You handle temporal consistency yourself.

| Platform | Model | Speed/frame | Cost/frame | Quality |
|---|---|---|---|---|
| **Replicate** | `bytedance/sdxl-lightning-4step` | ~1s | ~$0.002 | Medium (fast) |
| **Replicate** | `stability-ai/sdxl` img2img | 3-5s | ~$0.003 | Good |
| **Replicate** | `lucataco/ip-adapter-sdxl` | 3-5s | ~$0.005 | Good + style lock |
| **fal.ai** | `fal-ai/fast-sdxl` | <1s | ~$0.01 | Medium (fastest) |
| **fal.ai** | `fal-ai/flux/dev/image-to-image` | 2-3s | ~$0.025 | High |
| **Stability AI** | SD3/SDXL img2img | 2-4s | ~$0.006 | Good |

**ControlNet-enabled models (critical for consistency):**
- Replicate: `jagilley/controlnet-*`, community SDXL+ControlNet models
- fal.ai: `fal-ai/fast-sdxl-controlnet-canny` and variants
- Multi-ControlNet: available through ComfyUI-based Replicate models

### Video Foundation Models

Open-source models with temporal attention, available as APIs:

| Model | API | Video-to-Video | Temporal Consistency |
|---|---|---|---|
| **CogVideoX-5B** | Replicate, fal.ai | Yes | Good (3D causal attention) |
| **Wan 2.1** | Replicate, fal.ai | Yes | Good |
| **AnimateDiff** | Replicate, fal.ai | Partial (with ControlNet) | Good (temporal attention) |
| **Stable Video Diffusion** | Replicate, fal.ai, Stability | Limited (image-to-video) | Good |

**Note:** OpenRouter does not host video/image generation models — it's LLM-only.

---

## Part 2: The Flickering Problem & Temporal Consistency

### Why Frame-by-Frame Flickers

Each frame gets independent random noise during diffusion. Even with identical settings:

- **Independent noise sampling** — different noise tensor per frame, amplified through denoising
- **Mode collapse to different local optima** — many valid "stylized" versions exist, each frame picks a different one
- **High-frequency texture instability** — brush strokes, textures are hallucinated differently per frame
- **Denoise strength amplification** — small inter-frame motion becomes large output differences

**Types of artifacts:** flicker (brightness/color jumps), texture swimming, style drift, structural jitter, popping.

### ControlNet for Structure

ControlNet extracts structural information from the source frame and forces the styled output to match it.

**Best ControlNet models for video:**

| Model | Preserves | Best For | Conditioning Scale |
|---|---|---|---|
| **Depth (MiDaS/ZoeDepth)** | 3D spatial structure | General scenes | 0.75-0.85 |
| **Canny Edge** | Hard edges, boundaries | Architecture, clear objects | 0.7-0.85 |
| **SoftEdge (HED)** | Soft edges, organic structure | Natural scenes | 0.7-0.8 |
| **OpenPose** | Human body poses | Videos with people | 0.7-0.9 |
| **Tile** | Local detail + color | Color consistency | 0.5-0.7 |

**Multi-ControlNet (stacking):** Depth + Canny is the strongest combo for video. Reduce individual scales to ~0.5 each when stacking 2+. Available through ComfyUI-based API models.

### IP-Adapter for Style Lock

Instead of text prompts (interpreted differently per frame), use a **single style reference image**:

- IP-Adapter encodes the reference into CLIP embeddings injected into cross-attention
- Style conditioning is **identical across all frames** → more consistent
- `ip_adapter_scale`: 0.5-0.7 for video
- **Combine with ControlNet:** IP-Adapter handles style, ControlNet handles structure

Available on Replicate (`lucataco/ip-adapter-sdxl`) and fal.ai.

**The combo of ControlNet Depth + IP-Adapter + fixed seed is the single best frame-by-frame consistency recipe.**

### Optical Flow Warping

Uses the previous styled frame as a starting point for the next:

1. Style frame N
2. Compute optical flow between source frame N and N+1 (using **RAFT** or **GMFlow**)
3. Warp styled frame N using that flow → "predicted" styled frame N+1
4. Use warped result as init_image for styling frame N+1 (denoise 0.30-0.40)

**This is the Deforum approach.** Each frame starts from a warped version of the previous output rather than from scratch → natural continuity.

**Limitation:** Requires local compute for optical flow (RAFT). Not purely API-based. Errors accumulate over long sequences.

### EbSynth Keyframe Propagation

**Best temporal consistency** but requires local compute:

1. Style a few **keyframes** (every 30-50 frames) via API — can use high denoise (0.6-0.7)
2. EbSynth propagates the style to intermediate frames using PatchMatch texture synthesis
3. Cross-fade where keyframe regions overlap

**Keyframe density:**
- Slow/static scenes: every 60-120 frames
- Moderate motion: every 20-60 frames
- Fast motion: every 10-20 frames

**No cloud API** for EbSynth — it's a free desktop tool. Keyframes can be generated via any img2img API.

### Seed & Denoise Tuning

**Fixed seed:** Always use the same seed across all frames. Not sufficient alone but reduces variance.

**Denoise strength is the most impactful parameter:**

| Denoise | Consistency | Stylization | Use Case |
|---|---|---|---|
| 0.20-0.30 | Very high | Minimal (color grading) | Subtle filters |
| **0.30-0.45** | **High** | **Moderate (painterly)** | **Sweet spot for video** |
| 0.45-0.60 | Medium | Strong (clear style) | Needs ControlNet |
| 0.60-0.80 | Low | Very strong | Only with flow warping |
| 0.80-1.0 | None | Maximum | Unusable for video |

**For video: 0.35-0.50 with ControlNet.**

---

## Part 3: The 60fps Pipeline

### Frame Extraction

```bash
# Extract at 10fps, downscale to 1024 width (for SDXL)
ffmpeg -i input.mp4 -vf "fps=10,scale=1024:-2" frames/frame_%06d.png

# Extract at 15fps (higher quality, more frames to process)
ffmpeg -i input.mp4 -vf "fps=15,scale=1024:-2" frames/frame_%06d.png

# Extract keyframes only (for EbSynth approach)
ffmpeg -i input.mp4 -vf "select='eq(pict_type,I)'" -vsync vfr frames/keyframe_%06d.png
```

**Python (OpenCV):**
```python
import cv2, os

def extract_frames(video_path, output_dir, target_fps=10):
    cap = cv2.VideoCapture(video_path)
    original_fps = cap.get(cv2.CAP_PROP_FPS)
    frame_interval = int(original_fps / target_fps)
    os.makedirs(output_dir, exist_ok=True)
    frame_idx, saved_idx = 0, 0
    while True:
        ret, frame = cap.read()
        if not ret: break
        if frame_idx % frame_interval == 0:
            cv2.imwrite(f"{output_dir}/frame_{saved_idx:06d}.png", frame)
            saved_idx += 1
        frame_idx += 1
    cap.release()
    return saved_idx
```

**Format:** Use PNG for style transfer input (lossless). JPG q=95 for intermediate storage if disk is tight.

### Frame Interpolation (RIFE/FILM)

**Key insight: Process at 10fps, interpolate to 60fps.** This reduces API costs 6x.

| Model | Speed (1080p) | Quality | Large Motion | API |
|---|---|---|---|---|
| **RIFE v4.6+** | ~50ms/frame (GPU) | Excellent | Good | Replicate |
| **FILM** | ~500ms/frame | Excellent | Best | Replicate |
| **IFRNet** | ~30ms/frame | Very Good | Good | Limited |

**RIFE usage (local):**
```bash
git clone https://github.com/hzwer/Practical-RIFE
cd Practical-RIFE

# 8x interpolation: 10fps → 80fps
python inference_video.py --exp=3 --video=styled_10fps.mp4

# Then conform to 60fps
ffmpeg -i interpolated_80fps.mp4 -vf "fps=60" -c:v libx264 -crf 18 output_60fps.mp4
```

**RIFE on Replicate:** Available as `pollinations/rife-ncnn-vulkan` and similar.

**Why 8x then conform?** RIFE does 2x per pass. 3 passes = 2^3 = 8x. 10fps × 8 = 80fps. Conform down to 60fps with FFmpeg. Alternatively, do 2 passes (4x, 10→40fps) if 40fps is acceptable.

### Audio Preservation

```bash
# Extract audio
ffmpeg -i input.mp4 -vn -acodec aac -b:a 192k audio.aac

# Re-mux with styled video
ffmpeg -i styled_60fps.mp4 -i audio.aac -c:v copy -c:a copy -shortest output_final.mp4
```

### Batch Processing & Parallelization

```python
import asyncio, aiohttp, base64, os
from pathlib import Path

class StyleTransferBatch:
    def __init__(self, api_url, api_key, max_concurrent=20):
        self.api_url = api_url
        self.api_key = api_key
        self.sem = asyncio.Semaphore(max_concurrent)

    async def process_frame(self, session, frame_path, output_path, prompt, seed=42):
        async with self.sem:
            with open(frame_path, 'rb') as f:
                image_b64 = base64.b64encode(f.read()).decode()
            payload = {
                "prompt": prompt,
                "image": image_b64,
                "strength": 0.4,       # denoise
                "seed": seed,
                # "controlnet_image": depth_map_b64,  # if using ControlNet
                # "controlnet_conditioning_scale": 0.8,
            }
            async with session.post(self.api_url, json=payload,
                headers={"Authorization": f"Bearer {self.api_key}"}) as resp:
                result = await resp.json()
                output_data = base64.b64decode(result["output"])
                with open(output_path, 'wb') as f:
                    f.write(output_data)

    async def process_all(self, frames_dir, styled_dir, prompt):
        os.makedirs(styled_dir, exist_ok=True)
        frames = sorted(Path(frames_dir).glob("*.png"))
        async with aiohttp.ClientSession() as session:
            tasks = [
                self.process_frame(session, str(f),
                    f"{styled_dir}/{f.name}", prompt)
                for f in frames
            ]
            await asyncio.gather(*tasks, return_exceptions=True)
```

**Rate limiting:** Most APIs allow 20-50 concurrent requests. Use a semaphore.

### End-to-End Architecture

```python
#!/usr/bin/env python3
"""Video style transfer pipeline: input video → styled 60fps output."""

import subprocess, asyncio, os
from pathlib import Path

# ── Config ──
INPUT = "input.mp4"
OUTPUT = "output_60fps.mp4"
EXTRACT_FPS = 10
TARGET_FPS = 60
PROMPT = "oil painting, impressionist, thick brushstrokes"
WORK = Path("pipeline_work")

def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)

async def main():
    WORK.mkdir(exist_ok=True)

    # 1. Extract audio
    run(["ffmpeg", "-y", "-i", INPUT, "-vn", "-acodec", "aac",
         "-b:a", "192k", str(WORK / "audio.aac")])

    # 2. Extract frames at low FPS
    (WORK / "frames").mkdir(exist_ok=True)
    run(["ffmpeg", "-y", "-i", INPUT,
         "-vf", f"fps={EXTRACT_FPS},scale=1024:-2",
         str(WORK / "frames/frame_%06d.png")])

    # 3. Style transfer (replace with your API calls)
    # await batch_style_transfer(WORK/"frames", WORK/"styled", PROMPT)

    # 4. Reassemble at low FPS
    run(["ffmpeg", "-y", "-framerate", str(EXTRACT_FPS),
         "-i", str(WORK / "styled/frame_%06d.png"),
         "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
         str(WORK / "styled_lowfps.mp4")])

    # 5. RIFE 8x interpolation (10fps → 80fps)
    run(["python", "inference_video.py", "--exp=3",
         f"--video={WORK}/styled_lowfps.mp4",
         f"--output={WORK}/interpolated.mp4"],
        # cwd="Practical-RIFE"
    )

    # 6. Conform to 60fps
    run(["ffmpeg", "-y", "-i", str(WORK / "interpolated.mp4"),
         "-vf", f"fps={TARGET_FPS}",
         "-c:v", "libx264", "-crf", "18", str(WORK / "conformed.mp4")])

    # 7. Mux audio
    run(["ffmpeg", "-y",
         "-i", str(WORK / "conformed.mp4"),
         "-i", str(WORK / "audio.aac"),
         "-c:v", "copy", "-c:a", "copy", "-shortest", OUTPUT])

    print(f"Done: {OUTPUT}")

asyncio.run(main())
```

---

## Part 4: Practical Recipes

### Recipe 1: Quick & Cheap (API-only, minimal engineering)

**Use Kling v2 video-to-video via fal.ai.**

- Send 5-10s source video chunks + style prompt
- Kling handles temporal consistency natively
- Chain clips for longer videos
- Cost: ~$0.42-0.84 for 30 seconds
- Time: 2-6 minutes
- Consistency: very good (built-in)
- Control: limited (text prompt only)

### Recipe 2: Maximum Control (per-frame via API)

**SDXL img2img + ControlNet Depth + IP-Adapter + fixed seed.**

```
Per frame:
  1. Extract depth map (MiDaS — run locally or via Replicate)
  2. SDXL img2img with:
     - ControlNet Depth, scale: 0.75-0.85
     - IP-Adapter with style reference image, scale: 0.5-0.7
     - Denoise strength: 0.35-0.45
     - Fixed seed: 42
     - Sampler: DDIM or Euler (deterministic)
  3. Post-process: color histogram match to running average
```

- Extract at 10fps, interpolate to 60fps with RIFE
- Cost: ~$3-5 for 30 seconds (Replicate SDXL)
- Time: 5-10 minutes
- Consistency: good (with all the tricks)
- Control: maximum

### Recipe 3: Best Quality (EbSynth hybrid)

**AI-styled keyframes + EbSynth propagation.**

1. Extract keyframes every ~30 frames (1 per 3 seconds at 10fps)
2. Style each keyframe via API at high denoise (0.6-0.7) — quality matters, consistency doesn't (it's per-keyframe)
3. Run EbSynth locally to propagate style to all intermediate frames
4. Cross-fade overlapping regions
5. RIFE interpolate to 60fps

- Cost: ~$0.10-0.30 for 30 seconds (only ~10 keyframes to style!)
- Time: 5-15 minutes (EbSynth is fast)
- Consistency: **best** (texture propagation, not independent generation)
- Control: high (full control over keyframe style)
- Caveat: requires local EbSynth install, struggles with very fast motion

### Recipe 4: Native Video Model (least engineering)

**Use CogVideoX or Wan 2.1 on Replicate/fal.ai.**

- Send source video + style prompt
- Model handles temporal attention natively
- Process in 4-6 second chunks
- Cost: varies, ~$0.05-0.20 per chunk
- Time: 3-8 minutes
- Consistency: good (temporal attention layers)
- Control: moderate (text prompt + reference image on some models)

### Denoise Strength by Style Target

| Style | Denoise | Notes |
|---|---|---|
| Subtle color grading | 0.20-0.30 | Barely noticeable transform |
| Soft painterly overlay | 0.30-0.40 | The video sweet spot |
| Strong oil painting | 0.40-0.55 | Needs ControlNet depth |
| Anime / cartoon | 0.45-0.60 | Add Lineart ControlNet |
| Abstract / heavy style | 0.55-0.70 | Must use optical flow warping |

---

## Cost & Speed Comparison

### For a 30-second source video

| Approach | Frames Styled | Cost | Processing Time | Consistency |
|---|---|---|---|---|
| **Kling v2 (fal.ai)** | N/A (native v2v) | **$0.42-0.84** | 2-6 min | Very good |
| **Runway Gen-3 Turbo** | N/A (native v2v) | ~$1.50 | 1-3 min | Excellent |
| **EbSynth + API keyframes** | ~10 keyframes | **$0.10-0.30** | 5-15 min | Best |
| **Replicate SDXL-Lightning** | 300 @ 10fps | ~$1.50 | 5-10 min | Needs tricks |
| **fal.ai fast-sdxl + ControlNet** | 300 @ 10fps | ~$3-7 | 5-8 min | Good w/ ControlNet |
| **fal.ai Flux img2img** | 300 @ 10fps | ~$7.50 | 10-15 min | Good w/ ControlNet |
| **Replicate SDXL + IP-Adapter** | 300 @ 10fps | ~$1.50-3 | 5-10 min | Good |
| **CogVideoX / Wan 2.1** | N/A (native) | ~$1-3 | 3-8 min | Good |

### Cost per minute of output video

| Approach | $/minute |
|---|---|
| EbSynth + API keyframes | $0.20-0.60 |
| Kling v2 | $0.84-1.68 |
| Replicate SDXL per-frame | $3-6 |
| Runway Gen-3 | $3-6 |
| fal.ai Flux per-frame | $15-25 |

---

## Recommended Approach

### If you want the least engineering:

**Kling v2 via fal.ai** — cheapest native video-to-video, good consistency, just send chunks + prompt.

### If you want maximum style control:

**Per-frame SDXL + ControlNet Depth + IP-Adapter** on Replicate, with:
- 10fps extraction
- Denoise 0.35-0.45
- Fixed seed
- RIFE 8x interpolation to 60fps
- Total cost ~$3/30s, ~5-10 min processing

### If you want the best quality:

**EbSynth hybrid** — style ~10 keyframes via API (cheap), propagate with EbSynth (fast, local), RIFE to 60fps. Best consistency, lowest cost ($0.10-0.30/30s), but requires local EbSynth.

### Pipeline Summary

```
┌─────────────────────────────────────────────┐
│          OPTION A: Native V2V API           │
│                                             │
│  Input Video ──► Kling v2 / Runway Gen-3    │
│                  + style prompt             │
│                  ──► Styled Video           │
│                  ──► RIFE to 60fps          │
│                  ──► Mux Audio              │
│                  ──► Output                 │
│                                             │
│  Effort: Low | Cost: Low | Control: Low     │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│       OPTION B: Per-Frame + Interpolate     │
│                                             │
│  Input Video ──► Extract 10fps              │
│              ──► Extract depth maps         │
│              ──► SDXL img2img per frame     │
│                  + ControlNet Depth         │
│                  + IP-Adapter style ref     │
│                  + fixed seed, denoise 0.4  │
│              ──► Reassemble 10fps           │
│              ──► RIFE 8x → 80fps           │
│              ──► Conform 60fps             │
│              ──► Mux Audio                 │
│              ──► Output                    │
│                                             │
│  Effort: Medium | Cost: Medium | Control: Max│
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│       OPTION C: EbSynth Keyframes           │
│                                             │
│  Input Video ──► Extract keyframes (~1/3s)  │
│              ──► Style keyframes via API    │
│                  (high denoise OK)          │
│              ──► EbSynth propagate (local)  │
│              ──► Cross-fade overlaps        │
│              ──► RIFE 8x → 60fps           │
│              ──► Mux Audio                 │
│              ──► Output                    │
│                                             │
│  Effort: Medium | Cost: Lowest | Quality: Best│
└─────────────────────────────────────────────┘
```

---

## Key Tools & Links

| Tool | Purpose | Link |
|---|---|---|
| **FFmpeg** | Frame extraction, reassembly, audio | `ffmpeg.org` |
| **Practical-RIFE** | Frame interpolation (10fps→60fps) | `github.com/hzwer/Practical-RIFE` |
| **FILM** | Frame interpolation (large motion) | `github.com/google-research/frame-interpolation` |
| **EbSynth** | Keyframe style propagation | `ebsynth.com` |
| **Replicate** | Model hosting (SDXL, ControlNet, RIFE) | `replicate.com` |
| **fal.ai** | Fast inference (SDXL, Flux, Kling) | `fal.ai` |
| **Runway API** | Gen-3/Gen-4 video-to-video | `api.dev.runwayml.com` |
| **ComfyUI** | Visual pipeline builder | `github.com/comfyanonymous/ComfyUI` |
| **ComfyUI-VideoHelperSuite** | Video nodes for ComfyUI | `github.com/Kosinkadink/ComfyUI-VideoHelperSuite` |
| **ComfyUI-Frame-Interpolation** | RIFE/FILM nodes for ComfyUI | `github.com/Fannovel16/ComfyUI-Frame-Interpolation` |
| **Deforum** | Classic SD video pipeline | `github.com/deforum-art/deforum-stable-diffusion` |
| **Flowframes** | GUI frame interpolation tool | `github.com/n00mkrad/flowframes` |
