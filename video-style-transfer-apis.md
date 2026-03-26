# Off-the-Shelf Video Style Transfer APIs

> Upload a video + style prompt → get a styled video back. No pipelines, no DIY.
> Compiled March 2026.

---

## Every API That Actually Works Today

### Tier 1: Best Options

#### 1. WaveSpeed DITTO (Wan 2.1) — Cheapest, longest input
```bash
curl -X POST https://api.wavespeed.ai/api/v3/wavespeed-ai/wan-2.1/ditto \
  -H "Authorization: Bearer $WAVESPEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "video": "https://example.com/video.mp4",
    "prompt": "Studio Ghibli anime style",
    "resolution": "720p"
  }'
```
| Detail | Value |
|---|---|
| Price | **$0.04/s (480p), $0.08/s (720p)** |
| Max duration | **120 seconds** (far longer than anything else) |
| Resolution | 480p or 720p |
| Controls | Prompt, resolution, seed |
| Docs | https://wavespeed.ai/models/wavespeed-ai/wan-2.1/ditto |

Also offers **Synthetic-to-Real DITTO** (animated → photorealistic) at the same price.

---

#### 2. Luma Modify Video — Best style control (9 modes)
```bash
curl -X POST https://api.lumalabs.ai/dream-machine/v1/generations \
  -H "Authorization: Bearer $LUMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Transform into cyberpunk neon aesthetic",
    "media": {"url": "https://example.com/video.mp4"},
    "mode": "flex_2",
    "model": "ray-flash-2"
  }'
```
| Detail | ray-flash-2 | ray-2 |
|---|---|---|
| Price | **~$0.12/s** | ~$0.35/s |
| Max duration | 15s | 10s |
| Resolution | 720p | 720p |
| Controls | 9 modes: `adhere_1/2/3` (subtle), `flex_1/2/3` (balanced), `reimagine_1/2/3` (dramatic) + optional first_frame style reference |
| Docs | https://docs.lumalabs.ai/docs/modify-video |

**Even cheaper via WaveSpeed proxy:** $0.019/s, up to 30s
```bash
curl -X POST https://api.wavespeed.ai/api/v3/luma/modify-video \
  -H "Authorization: Bearer $WAVESPEED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "video": "https://example.com/video.mp4",
    "prompt": "anime style",
    "mode": "reimagine_2"
  }'
```

---

#### 3. fal.ai Wan 2.2 — Best fine-grained strength control
```python
import fal

result = fal.subscribe("fal-ai/wan/v2.2-a14b/video-to-video", {
    "input": {
        "video_url": "https://example.com/source.mp4",
        "prompt": "watercolor painting style, soft brushstrokes",
        "strength": 0.85,   # 0.0 (no change) to 1.0 (full restyle)
        "resolution": "720p"
    }
})
print(result["data"]["video"]["url"])
```
| Detail | Value |
|---|---|
| Price | **~$0.10/s** |
| Max duration | ~10s (161 frames at 16fps) |
| Resolution | 480p, 580p, or 720p |
| Output FPS | 4-60 (default 16) |
| Controls | `strength` slider (0-1), `guidance_scale`, `negative_prompt`, `num_inference_steps` |
| Docs | https://fal.ai/models/fal-ai/wan/v2.2-a14b/video-to-video/api |

---

#### 4. Runway Gen-4 Aleph — Highest quality
```bash
curl -X POST https://api.runwayml.com/v1/video_to_video \
  -H "Authorization: Bearer $RUNWAY_KEY" \
  -H "X-Runway-Version: 2024-11-06" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gen4_aleph",
    "videoUri": "https://example.com/video.mp4",
    "promptText": "oil painting style, rich colors, thick brushstrokes",
    "references": [{"type": "image", "uri": "https://example.com/style.jpg"}]
  }'
```
| Detail | Value |
|---|---|
| Price | **$0.15/s** |
| Max input | 5 seconds (auto-crops longer) |
| Output | 2-10 seconds |
| Resolution | Matches input (up to 1584x672) |
| Controls | Prompt + 1 style reference image |
| Docs | https://docs.dev.runwayml.com/api/ |

---

### Tier 2: Specialized / Alternative

#### 5. fal.ai Kling O1 Edit — Highest resolution (up to 4K)
```python
fal.subscribe("fal-ai/kling-video/o1/video-to-video/edit", {
    "input": {
        "prompt": "Transform into Studio Ghibli anime style",
        "video_url": "https://example.com/video.mp4",
        "image_urls": ["https://example.com/style-ref.jpg"]  # up to 4
    }
})
```
| Detail | Value |
|---|---|
| Price | $0.168/s |
| Max duration | 10s |
| Resolution | Up to 2160p (4K) |
| Controls | Prompt + up to 4 reference images + element definitions |
| Docs | https://fal.ai/models/fal-ai/kling-video/o1/video-to-video/edit/api |

Also available as **Kling O1 Reference** (same price, preserves camera/motion style): `fal-ai/kling-video/o1/video-to-video/reference`

---

#### 6. fal.ai Hunyuan Video-to-Video — Open-source model
```bash
curl -X POST https://fal.run/fal-ai/hunyuan-video/video-to-video \
  -H "Authorization: Bearer $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "impressionist oil painting",
    "video_url": "https://example.com/input.mp4",
    "strength": 0.85,
    "resolution": "720p"
  }'
```
| Detail | Value |
|---|---|
| Price | 5 credits/request |
| Resolution | 720p |
| Controls | `strength` (0.01-1.0) |
| Docs | https://fal.ai/models/fal-ai/hunyuan-video/video-to-video/api |

---

#### 7. Replicate — luma/modify-video
```python
import replicate

output = replicate.run("luma/modify-video", input={
    "video": "https://example.com/video.mp4",
    "prompt": "anime style transformation",
    "mode": "flex_2",
    "model": "ray-flash-2"
})
```
| Detail | Value |
|---|---|
| Price | Per-compute (Replicate billing) |
| Max duration | 21s |
| Controls | 9 modes (same as Luma direct) |
| Docs | https://replicate.com/luma/modify-video |

---

#### 8. Replicate — zsxkib/hunyuan-video2video
```python
output = replicate.run("zsxkib/hunyuan-video2video", input={
    "video": "https://example.com/video.mp4",
    "prompt": "oil painting style, Van Gogh"
})
```
| Detail | Value |
|---|---|
| Price | ~$0.65/run |
| Hardware | Nvidia H100 |
| Docs | https://replicate.com/zsxkib/hunyuan-video2video |

---

#### 9. AIML API — Unified gateway for multiple models
```python
import requests

requests.post("https://api.aimlapi.com/v2/video/generations", json={
    "model": "klingai/video-o1-video-to-video-edit",  # or runway/gen4_aleph, krea/wan-14b, etc.
    "prompt": "anime style",
    "video_url": "https://example.com/video.mp4"
}, headers={"Authorization": "Bearer $AIML_KEY"})
```
| Detail | Value |
|---|---|
| Models | Kling O1 Edit, Kling O1 Reference, Runway Gen4, Krea Wan 14B, Magic V2V |
| Price | Per-model (credit system) |
| Docs | https://docs.aimlapi.com/api-references/video-models |

---

### Tier 3: Enterprise / Limited Access

| Platform | Status | Notes |
|---|---|---|
| **DomoAI** | Enterprise only | 40+ preset styles, contact sales@domoai.app |
| **Kaiber** | Credit-based, limited API docs | Transform 3.0 feature, $15/mo for 1000 credits |
| **Kling Direct** | Available but less documented for V2V | Effects endpoint at klingai.com/global/dev |

---

## What Does NOT Have Video-to-Video

| Platform | What they have instead |
|---|---|
| **Google Veo 2/3** | Text-to-video and image-to-video only |
| **OpenAI Sora** | fal.ai has remix but only for Sora-generated videos |
| **Stability AI** | Video API discontinued July 2025 |
| **Pika** | V2V in UI only, API is text/image-to-video |
| **MiniMax/Hailuo** | Text/image-to-video only |
| **Genmo/Mochi** | Text-to-video only |
| **SiliconFlow** | Text/image-to-video only |
| **Together AI** | Text/image-to-video only |
| **Fireworks AI** | No video models |
| **Black Forest Labs** | Image models only (FLUX) |
| **Novita AI** | Image-to-video only |

---

## Quick Decision Guide

```
Do you need videos longer than 10 seconds?
├── YES, up to 120s → WaveSpeed DITTO ($0.04-0.08/s)
├── YES, up to 30s  → WaveSpeed Luma proxy ($0.019/s)
└── NO (under 10s)
    │
    Do you need fine-grained strength control?
    ├── YES → fal.ai Wan 2.2 (strength slider 0-1, $0.10/s)
    └── NO
        │
        Do you need preset style modes (subtle → dramatic)?
        ├── YES → Luma Modify Video (9 modes, $0.12/s)
        └── NO
            │
            Do you need the highest quality?
            ├── YES → Runway Gen-4 Aleph ($0.15/s, 5s max)
            └── NO
                │
                Do you need high resolution (4K)?
                ├── YES → fal.ai Kling O1 ($0.168/s, up to 2160p)
                └── Just the cheapest → WaveSpeed DITTO ($0.04/s)
```

---

## Cost Comparison (30-second video)

| API | Approach | Total Cost | Notes |
|---|---|---|---|
| **WaveSpeed DITTO** | 1 call (120s max) | **$1.20** (480p) / **$2.40** (720p) | Cheapest, single call |
| **WaveSpeed Luma** | 1 call (30s max) | **$0.57** | Cheapest Luma |
| **Luma ray-flash-2** | 2x 15s clips | **$3.60** | Best style modes |
| **fal.ai Wan 2.2** | 3x 10s clips | **$3.00** | Best strength control |
| **fal.ai Kling O1** | 3x 10s clips | **$5.04** | Up to 4K |
| **Runway Gen-4** | 6x 5s clips | **$4.50** | Highest quality |
| **Luma ray-2** | 3x 10s clips | **$10.50** | Premium Luma |
