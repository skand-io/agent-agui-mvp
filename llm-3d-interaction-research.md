# LLM + 3D Canvas Interaction: Research Report

> How can an LLM understand what's in a 3D scene, interact with it, and click on objects?
> Compiled March 2026 from parallel research across scene understanding, interaction methods, and production architectures.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Part 1: Understanding the Scene](#part-1-understanding-the-scene)
   - [Scene Graph Serialization](#1a-scene-graph-serialization)
   - [Vision-Language Models (VLMs)](#1b-vision-language-models)
   - [3D-Native Foundation Models](#1c-3d-native-foundation-models)
   - [Language-Embedded Neural Fields (LERF, LangSplat)](#1d-language-embedded-neural-fields)
   - [Multi-View Approaches](#1e-multi-view-approaches)
3. [Part 2: Interacting With the Scene](#part-2-interacting-with-the-scene)
   - [Computer-Use / GUI Agents](#2a-computer-use--gui-agents)
   - [Tool-Use APIs & MCP Servers](#2b-tool-use-apis--mcp-servers)
   - [Coordinate-Based Interaction](#2c-coordinate-based-interaction)
   - [Set-of-Marks / Visual Grounding](#2d-set-of-marks--visual-grounding)
   - [Embodied AI Agents](#2e-embodied-ai-agents)
4. [Part 3: Production Architectures](#part-3-production-architectures)
   - [Three.js / React Three Fiber + LLM](#3a-threejs--react-three-fiber--llm)
   - [Blender + LLM](#3b-blender--llm)
   - [Unity / Unreal + LLM](#3c-unity--unreal--llm)
   - [CAD + LLM](#3d-cad--llm)
   - [Web 3D Editors + AI](#3e-web-3d-editors--ai)
   - [MCP Servers for 3D (the emerging standard)](#3f-mcp-servers-for-3d)
5. [Part 4: Recommended Architecture](#part-4-recommended-architecture)
6. [Comparison Matrix](#comparison-matrix)
7. [Key GitHub Repositories](#key-github-repositories)
8. [References](#references)

---

## Executive Summary

There are **three fundamental challenges** when connecting an LLM to a 3D canvas:

1. **Scene Understanding** — How does the LLM know what's in the scene?
2. **Action Specification** — How does the LLM express what it wants to do?
3. **Action Execution** — How are the LLM's intentions applied to the 3D engine?

The best approach depends on your use case, but the **current production-ready winner is structured tool calling via MCP**, where:
- The scene is serialized as a compact JSON scene graph (not raw vertices)
- The LLM calls predefined tools (`addObject`, `moveObject`, `setMaterial`, etc.)
- A bridge layer (MCP server or WebSocket) translates tool calls into engine API calls
- Optionally, rendered screenshots supplement the JSON for visual grounding

For research/cutting-edge applications, 3D-native foundation models (PointLLM, LEO, 3D-LLM) and language-embedded neural fields (LERF, LangSplat) represent the frontier.

---

## Part 1: Understanding the Scene

### 1a. Scene Graph Serialization

The simplest and most production-ready approach: serialize the 3D scene into structured JSON that the LLM can parse.

**How it works:**
```json
{
  "objects": [
    {"id": "cube_1", "type": "mesh", "geometry": "box", "position": [0, 1, 0],
     "material": {"color": "red"}, "children": []},
    {"id": "light_1", "type": "directional_light", "position": [5, 10, 5]}
  ],
  "relationships": [
    {"subject": "cube_1", "predicate": "on_top_of", "object": "floor"}
  ]
}
```

**Key projects:**
- **ConceptGraphs** (Gu et al., RSS 2024) — Open-vocabulary 3D scene graphs built by combining CLIP + GPT-4V with 3D reconstruction. GitHub: `concept-graphs/concept-graphs`
- **SayPlan** (Rana et al., CoRL 2023) — Uses 3D scene graphs as the interface for LLM-based task planning in robotics
- **SceneScript** (Meta, 2024) — A scripting language for describing 3D scenes, designed to be LLM-friendly
- **Holodeck** (CVPR 2024) — GPT-4 generates 3D environments from text via structured scene specs. GitHub: `allenai/Holodeck`

**Practical tips:**
- **Token budget:** Large scenes easily exceed context windows. Use LOD descriptions, spatial indexing (only describe nearby objects), and hierarchical summarization (room → object → part)
- **Qualitative > quantitative:** LLMs reason better with "left of" / "above" / "inside" than raw float coordinates. Consider converting coordinates to spatial relations
- **~2000 tokens** is a good budget for scene context per LLM call

### 1b. Vision-Language Models

General-purpose VLMs (GPT-4o, Claude Vision, Gemini) can interpret rendered screenshots without needing structured data.

**Practical patterns (best → simplest):**
1. **Screenshot + scene graph hybrid** — Send both a rendered image AND JSON description. Cross-reference visual and structural info
2. **Annotated screenshots** — Overlay bounding boxes, depth maps, or numbered labels on the render before sending to VLM. Significantly improves accuracy
3. **Video/animation** — Send a turntable animation or walkthrough to video-capable VLMs (Gemini 1.5, GPT-4o)
4. **Single screenshot** — Quick but lossy. Works for simple queries

**Notable VLMs with spatial strength:**
- **SpatialVLM** (Google, 2024) — Trained with quantitative spatial annotations for metric spatial understanding
- **Qwen2-VL** (Alibaba, 2024) — Open-source, strong spatial understanding. GitHub: `QwenLM/Qwen2-VL`
- **Cambrian-1** (NYU, 2024) — Multiple visual encoders in parallel (depth + segmentation specialists)
- **SpatialBot** (2024) — VLM enhanced for spatial understanding using depth information

### 1c. 3D-Native Foundation Models

Models specifically trained on 3D data (point clouds, meshes) rather than relying on 2D renders.

| Model | Input | Capabilities | Venue | GitHub |
|---|---|---|---|---|
| **3D-LLM** | Multi-view features | 3D captioning, QA, grounding, navigation | NeurIPS 2023 | `UMass-Foundation-Model/3D-LLM` |
| **PointLLM** | Raw point clouds | Object description, geometry QA, classification | ECCV 2024 | `OpenRobotLab/PointLLM` |
| **LEO** | Ego-centric point clouds + object features | 3D QA, embodied reasoning, navigation, manipulation | ICML 2024 | `embodied-generalist/LEO` |
| **Scene-LLM** | Full scene point clouds + images | Dense captioning, visual grounding, room-scale QA | CVPR 2024 | — |
| **LL3DA** | Point clouds + visual prompts (clicks, boxes) | Interactive 3D QA with pointing | 2024 | `Open3DA/LL3DA` |
| **Chat-3D v2** | Object-centric 3D features | Referring expressions, attribute grounding | 2024 | — |
| **Grounded 3D-LLM** | Multi-view 3D features | Grounded responses with bounding boxes/masks | 2024 | — |

### 1d. Language-Embedded Neural Fields

Combine NeRF / Gaussian Splatting with language features so every point in 3D space has a language embedding.

**For querying ("where is the coffee mug?"):**
- **LERF** (ICCV 2023) — Embeds CLIP features into NeRF. Open-vocabulary 3D spatial queries. GitHub: `kerrj/lerf`
- **LangSplat** (CVPR 2024) — Gaussian Splatting equivalent of LERF. Faster. GitHub: `minghanqin/LangSplat`
- **OpenScene** (CVPR 2023) — Distills CLIP features into 3D point clouds

**For editing ("make it look like winter"):**
- **Instruct-NeRF2NeRF** (ICCV 2023) — Text-guided NeRF editing. GitHub: `ayaanzhaque/instruct-nerf2nerf`
- **GaussianEditor** (CVPR 2024) — Text-guided editing of Gaussian Splatting scenes
- **GaussCtrl** (2024) — Multi-view consistent text-driven Gaussian editing

**For LLM orchestration:**
- **LLM-Grounder** (2024) — LLM decomposes complex 3D grounding queries into sub-queries resolved by LERF

### 1e. Multi-View Approaches

Compensate for VLMs' lack of native 3D understanding by providing multiple viewpoints.

**Strategies:**
- **Fixed camera arrays** — Render from front/back/left/right/top/45-degree angles. Simplest approach
- **Depth-augmented views** — Send RGB + depth maps together. SpatialRGPT (2024) demonstrates this gains metric spatial understanding
- **Active perception** — In embodied settings, the LLM-agent chooses where to look next
- **Video as implicit multi-view** — Orbital camera animation sent to video-capable VLM

---

## Part 2: Interacting With the Scene

### 2a. Computer-Use / GUI Agents

Treat the 3D application as an opaque visual surface: see screenshots, output mouse/keyboard actions.

| Agent | Benchmark Score | Approach |
|---|---|---|
| **Claude Computer Use** (Anthropic) | 72.5% OSWorld | Screenshot → analyze → click/type |
| **OpenAI Operator / CUA** | 38.1% OSWorld | GPT-4o vision + RL for GUI interaction |
| **Gemini Computer Use** | — | Normalized 0-1000 coordinate space |
| **Cradle** (ICLR 2024) | 40-min Red Dead Redemption 2 missions | 6-module agent (reflection, skill library, memory) |

**Key limitation for 3D:** These agents see 3D canvases as 2D pixel grids. They cannot understand 3D structure — they can only click where they see interactive elements. Precise 3D manipulation (moving an object to exact coordinates) is extremely difficult through this approach alone.

**When to use:** When you need to interact with an **existing** 3D application you can't modify.

### 2b. Tool-Use APIs & MCP Servers

The LLM calls structured functions to manipulate the scene programmatically. **Most practical and reliable approach for production.**

**Existing MCP servers for 3D engines:**

| Server | Engine | Key Tools | GitHub |
|---|---|---|---|
| **Three.js MCP** | Three.js | create/move/rotate objects, query scene | `locchung/three-js-mcp` |
| **Hello3DMCP** | Three.js + Claude | rotation, zoom, lighting via WebSocket | `turner/hello3dmcp-frontend` |
| **MCP for Babylon** | Babylon.js + CesiumJS | camera ops, lights, mesh manipulation, picking | `pandaGaume/mcp-for-babylon` |
| **BlenderMCP** | Blender | full object/edit/material/UV control | `blender-mcp.com` |
| **Blender-MCP-Server** | Blender | 51 tools, thread-safe | `poly-mcp/Blender-MCP-Server` |
| **UnrealMCP** | Unreal Engine | scene info, create/delete/modify, execute Python | `kvick-games/UnrealMCP` |
| **UnrealGenAISupport** | Unreal Engine | Claude/GPT/Gemini, blueprints, Python scripts | `prajwalshettydev/UnrealGenAISupport` |

**Architecture:**
```
User Prompt → LLM → Tool Call (JSON) → MCP Server → WebSocket/API → 3D Engine
                                                                        ↓
                                                                   Scene Updates
```

**Also notable:**
- **SceneCraft** (ICML 2024) — LLM agent converts text to Blender Python scripts with GPT-V visual feedback loop
- **LLM_Plays_3D** — In-browser Qwen 7B controlling Three.js via tool calling, including a `tool_creation_tool` that lets the LLM generate new tools on demand. GitHub: `neuroidss/LLM_Plays_3D`

### 2c. Coordinate-Based Interaction

LLMs output specific pixel or 3D coordinates to specify where to interact.

**2D pixel coordinates:**
- **CogAgent** (CVPR 2024) — 18B VLM, outputs pixel coordinates for click actions. GitHub: `zai-org/CogAgent`
- **ShowUI** (CVPR 2025) — 2B-4.2B param model, 75.1% zero-shot screenshot grounding accuracy. GitHub: `showlab/ShowUI`
- **Gemini normalized coords** — Outputs in 0-1000 range, mapped to actual pixels

**3D world coordinates:**
- **3D-LLM** (NeurIPS 2023) — Takes point clouds as input, outputs 3D bounding boxes for grounding
- **GPT4Point** (CVPR 2024) — Point cloud → language understanding and generation
- **PointLLM** (ECCV 2024) — Direct point cloud understanding

**Case study — GPT-4V playing DOOM (2024):** Two-stage pipeline: GPT-4V converts screenshots → text descriptions → GPT-4 generates inputs. Can manipulate doors and combat enemies but suffers from lack of object permanence and poor spatial reasoning.

### 2d. Set-of-Marks / Visual Grounding

Annotate rendered views with visual markers (numbers, bounding boxes, contours) so the LLM can reference specific objects by label instead of coordinates.

**Key works:**
- **3DAxisPrompt** (2025) — Overlays coordinate axes, SAM masks, bounding boxes, and numbered marks onto 3D scene images. Supports both 2D marks (on image) and 3D marks (in scene, then rendered)
- **SeeGround** (CVPR 2025) — Projects 3D bounding boxes onto 2D images with visual prompts. +7.7% on ScanRefer over prior methods, rivaling supervised approaches. GitHub: `iris0329/SeeGround`
- **3DGraphLLM** (ICCV 2025) — Learnable 3D scene graph as LLM input, nodes represent objects with spatial relationships. GitHub: `CognitiveAISystems/3DGraphLLM`
- **GLaMM** (CVPR 2024) — Generates natural language responses intertwined with pixel-level segmentation masks. GitHub: `mbzuai-oryx/groundingLMM`

### 2e. Embodied AI Agents

LLMs controlling agents in simulated 3D environments — most relevant for robotics and game AI.

**Simulation platforms:**
- **AI2-THOR** — Photorealistic Unity-based simulator (vision, manipulation, navigation)
- **Habitat** (Meta) — High-fidelity 3D simulator for embodied AI
- **OmniGibson** (Stanford) — NVIDIA Omniverse-based, supports fluids/cloth/deformables

**Game agents:**
- **Voyager** (2023, NVIDIA) — LLM-powered lifelong learning Minecraft agent. 3.3x more unique items, 15.3x faster milestone unlocks vs prior methods. GitHub: `MineDojo/Voyager`
- **Cradle** (ICLR 2024) — Completed 40-minute Red Dead Redemption 2 missions

**Benchmark: EmbodiedBench** (ICML 2025) — 1,128 tasks, 24 MLLMs evaluated. GPT-4o scores only 28.9% average. MLLMs excel at high-level planning but struggle with low-level manipulation.

---

## Part 3: Production Architectures

### 3a. Three.js / React Three Fiber + LLM

**The dominant pattern:**
```
User Prompt
    ↓
LLM (with scene context as filtered JSON from scene.toJSON())
    ↓
Output: Tool calls / R3F JSX / Scene JSON patch
    ↓
Runtime applies changes → Scene re-renders
```

**For R3F specifically:** The declarative React component model is a natural fit for LLM code generation — the LLM generates JSX, which React reconciles.

**For real-time interaction:** A tool-calling pattern works better than raw code generation. Define tools like `addMesh`, `moveMesh`, `setMaterial`, `deleteMesh` and let the LLM call them.

**Key project:** [Triplex](https://triplex.dev) — Visual editor for R3F that generates/edits R3F code. Natural surface for LLM integration.

### 3b. Blender + LLM

**The most successful LLM + 3D integration** because Blender has a comprehensive Python API (`bpy`) where nearly every operation is scriptable.

```
User prompt → LLM (with bpy API docs + scene summary) → Python code → Execute in Blender
```

**Projects:** BlenderGPT (~4.5k GitHub stars), multiple MCP servers (see 2b above).

### 3c. Unity / Unreal + LLM

- **Unity Muse** — Official Unity product, natural language to C# code generation, texture/animation assistance
- **Inworld AI** — Leading LLM-powered NPC product. Separates "cognitive" layer (LLM) from "embodiment" layer (engine animation/physics)
- **Convai** — AI characters with spatial awareness (can perceive/reference 3D objects)
- **LLM for Unity** — Runs LLMs directly in Unity via llama.cpp. GitHub: `undreamai/LLMUnity`
- **NVIDIA ACE** — Avatar Cloud Engine for AI-driven characters
- **Flopperam** — Commercial product for controlling UE5 with natural language

### 3d. CAD + LLM

Code-based CAD tools are easiest to connect to LLMs: `natural language → LLM → domain code → engine renders`

- **OpenSCAD** — C-like scripting, LLMs generate it well
- **CadQuery** — Pure Python parametric CAD. GitHub: `CadQuery/cadquery`
- **Zoo.dev** (formerly KittyCAD) — KCL language designed to be LLM-friendly, text-to-CAD API
- **Onshape** — REST API + FeatureScript domain language

### 3e. Web 3D Editors + AI

- **Spline AI** — Text-to-3D, AI textures within the editor
- **Meshy** — Text/image to 3D mesh generation (diffusion-based)
- **Luma AI** — Gaussian Splat capture + Genie text-to-3D

Most use diffusion models (not LLMs) for geometry creation, with LLMs for intent understanding and orchestration.

### 3f. MCP Servers for 3D

The **most rapidly evolving area** (2025-2026). MCP provides a standard protocol for LLMs to interact with 3D applications.

**Architecture:**
```
LLM Client (Claude, GPT, etc.)
    │  MCP Protocol (JSON-RPC over stdio/SSE)
    ▼
MCP Server
    ├── Resources (read scene state)
    │   ├── scene://hierarchy
    │   ├── scene://objects/{id}
    │   └── scene://camera
    │
    ├── Tools (mutate scene)
    │   ├── create_object(type, position, material)
    │   ├── modify_object(id, properties)
    │   ├── delete_object(id)
    │   ├── set_camera(position, target)
    │   └── execute_code(code)  // escape hatch
    │
    └── 3D Application (Blender, Three.js, Unity, etc.)
```

---

## Part 4: Recommended Architecture

### The Three Canonical Patterns

| Pattern | Mechanism | Best For | Safety | Flexibility |
|---|---|---|---|---|
| **A: Code Generation** | LLM → domain code (bpy, JSX, OpenSCAD) → execute | Power-user tools, creative workflows | Low (arbitrary code) | Maximum |
| **B: Structured Tool Calling** | LLM → tool calls (JSON) → tool executor → engine | Production apps, user-facing products | High (constrained) | Medium |
| **C: Scene Diff** | LLM → scene JSON patch → apply to scene graph | Declarative frameworks (R3F) | Medium | Medium |

### Recommended: Hybrid Tool-Calling Architecture

For a web-based 3D + LLM application (especially with AG-UI protocol):

```
┌──────────────────────────────────────────────────┐
│                   Frontend                        │
│                                                   │
│  ┌────────────┐        ┌──────────────────┐      │
│  │  Chat UI   │        │  3D Canvas (R3F) │      │
│  │  (AG-UI)   │        │                  │      │
│  └─────┬──────┘        └────────┬─────────┘      │
│        │       ┌────────────┐   │                 │
│        └──────►│ Scene State │◄──┘                 │
│                │  (Zustand)  │                    │
│                └──────┬──────┘                    │
│                       │                           │
│  Frontend Tools:      │                           │
│  • addObject()   • moveObject()                   │
│  • setMaterial() • deleteObject()                 │
│  • selectObject()• setCamera()                    │
└───────────┬───────────────────────────────────────┘
            │ SSE (AG-UI Protocol)
            ▼
┌──────────────────────────────────────────────────┐
│                   Backend                         │
│                                                   │
│  ┌─────────────┐    ┌────────────────────────┐   │
│  │ FastAPI SSE  │───►│  LLM (with scene JSON  │   │
│  │  /chat       │◄───│  as system context +   │   │
│  │              │    │  3D tool definitions)  │   │
│  └─────────────┘    └────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **3D tools should be frontend tools** in the AG-UI pattern — the scene lives in the browser, no server round-trip needed, immediate visual feedback

2. **Expose scene state as system context** — Before each LLM call, serialize current scene state (~2000 tokens) into the system prompt

3. **What to expose to the LLM:**
   - Always: object hierarchy (name, type, position), camera state, available primitives
   - When relevant: materials, lights, animations, selection state
   - Never: raw vertex/face data, texture data, internal engine state

4. **Implement an undo stack** — LLMs make mistakes. Users need easy rollback

5. **Consider "preview before apply"** — For destructive operations, show what the LLM wants to do before executing (like a diff view)

6. **Optionally add screenshot grounding** — Render the scene, send the screenshot alongside the JSON for visual verification. Use annotated screenshots with numbered labels for object reference

---

## Comparison Matrix

| Approach | Best For | Precision | Latency | Integration Effort | Maturity |
|---|---|---|---|---|---|
| Scene Graph JSON + Tool Calls | Interactive editors, web apps | High | Low | Medium | Production-ready |
| VLM + Rendered Screenshots | Quick analysis, prototyping | Medium | Medium | Low | Production-ready |
| Computer-Use (screenshot + click) | Existing 3D apps you can't modify | Low | High | Low | Available now |
| 3D Foundation Models (PointLLM, LEO) | Research, specialized understanding | High | Medium-High | High | Research stage |
| LERF / LangSplat | Spatial language queries in scans | Medium | Medium | High | Research stage |
| Set-of-Marks | Zero-shot scene understanding | Medium | Medium | Medium | Emerging |
| MCP Server | Standardized engine integration | High | Low | Medium | Early but growing fast |
| Embodied AI Simulators | Robotics training, game AI | High | Medium | High | Research stage |

---

## Key GitHub Repositories

### Scene Understanding
| Repository | Description |
|---|---|
| `concept-graphs/concept-graphs` | Open-vocabulary 3D scene graphs |
| `UMass-Foundation-Model/3D-LLM` | 3D-LLM foundation model |
| `OpenRobotLab/PointLLM` | Point cloud understanding with LLMs |
| `embodied-generalist/LEO` | Embodied generalist agent |
| `Open3DA/LL3DA` | Large Language 3D Assistant |
| `kerrj/lerf` | Language Embedded Radiance Fields |
| `minghanqin/LangSplat` | Language-embedded Gaussian Splatting |
| `allenai/Holodeck` | LLM-based 3D environment generation |
| `QwenLM/Qwen2-VL` | Open-source VLM with spatial reasoning |

### Interaction & Control
| Repository | Description |
|---|---|
| `iris0329/SeeGround` | Zero-shot 3D visual grounding (CVPR 2025) |
| `CognitiveAISystems/3DGraphLLM` | 3D scene graph as LLM input (ICCV 2025) |
| `showlab/ShowUI` | GUI grounding model (CVPR 2025) |
| `zai-org/CogAgent` | VLM for GUI understanding (CVPR 2024) |
| `mbzuai-oryx/groundingLMM` | GLaMM pixel-level grounding (CVPR 2024) |
| `MineDojo/Voyager` | LLM lifelong learning in Minecraft |
| `neuroidss/LLM_Plays_3D` | In-browser LLM controlling Three.js |
| `bagh2178/SG-Nav` | Scene graph navigation (NeurIPS 2024) |

### MCP Servers & Engine Integration
| Repository | Description |
|---|---|
| `poly-mcp/Blender-MCP-Server` | 51-tool Blender MCP server |
| `kvick-games/UnrealMCP` | Unreal Engine MCP server |
| `prajwalshettydev/UnrealGenAISupport` | Multi-LLM Unreal plugin |
| `pandaGaume/mcp-for-babylon` | Babylon.js + CesiumJS MCP server |
| `turner/hello3dmcp-frontend` | Three.js + Claude MCP demo |
| `undreamai/LLMUnity` | Run LLMs directly in Unity |
| `gd3kr/BlenderGPT` | Natural language → Blender Python |
| `ayaanzhaque/instruct-nerf2nerf` | Text-guided NeRF editing |

### Curated Lists
| Repository | Description |
|---|---|
| `ActiveVisionLab/Awesome-LLM-3D` | Comprehensive LLM + 3D paper list |
| `HCPLab-SYSU/Embodied_AI_Paper_List` | Embodied AI survey (2025) |
| `GT-RIPL/Awesome-LLM-Robotics` | LLMs for robotics |
| `git-disl/awesome-LLM-game-agent-papers` | LLM game agents |

---

## References

**Key Papers:**
- 3D-LLM (NeurIPS 2023) — Hong et al.
- PointLLM (ECCV 2024) — Xu et al.
- LEO (ICML 2024) — Huang et al.
- LERF (ICCV 2023) — Kerr et al.
- LangSplat (CVPR 2024) — Qin et al.
- SeeGround (CVPR 2025)
- 3DAxisPrompt (2025)
- SceneCraft (ICML 2024)
- Voyager (2023, NVIDIA)
- Cradle (ICLR 2024)
- EmbodiedBench (ICML 2025)
- SpatialVLM (Google, 2024)
- ConceptGraphs (RSS 2024)
- Holodeck (CVPR 2024)
- GLaMM (CVPR 2024)

**Products & Platforms:**
- [Claude Computer Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [OpenAI Operator](https://openai.com/index/introducing-operator/)
- [Unity Muse](https://unity.com/products/muse)
- [Inworld AI](https://inworld.ai)
- [Spline AI](https://spline.design)
- [Zoo.dev](https://zoo.dev)
- [Triplex](https://triplex.dev)
- [Flopperam](https://www.flopperam.com/)

**Upcoming:** 2nd 3D-LLM/VLA Workshop at CVPR 2026 — [3d-llm-vla.github.io](https://3d-llm-vla.github.io/)
