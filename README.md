# ForgeSkin MMD 版

GTFO 的人物模型 + 舞蹈编辑器（Thunderstore 上 ForgeSkin / ForgeCore 的 MMD 定制版）。

- **人物**：导入 `.glb` / `.vrm` 人物模型，挑骨骼、编辑头发/裙摆弹簧物理（ChainSpec 全套参数 + 3D 选中发束）、量取贴合表面的身体碰撞壳，导出 `.forgeskin` 包应用到游戏。
- **舞蹈**：导入 VMD 动作 / VMD 镜头 / 表情 / 同名 `.wav` 音乐，三轨剪辑（动作、镜头、音乐各自裁切拖动），导出 `.dance` / `.cam` / `.face`，游戏里按 F9 播放。
- 依赖只有 BepInEx 6 (IL2CPP) 和 GTFO_API，其余不自动安装。

## 目录

| 路径 | 内容 |
|---|---|
| `ForgeSkin/Editor` | 编辑器本体（Electron + Vite + React 19 + Mantine + three.js） |
| `ForgeSkin/Backend` | 编辑器的 JSON-RPC 后端（.NET 10，打包 .forgeskin、调用 Blender 烘焙） |
| `ForgeSkin` | 游戏内 ForgeSkin 插件（人物皮肤 / 模型替换）与打包工具 |
| `ForgeCore` | 共享运行时（导入模型、ChainPhysics 弹簧物理、表情） |
| `Web` | 编辑器用到的 Web 端模块 |
| `CHANGELOG-MMD.md` | 相对开源版的全部改动 |

## 编译与运行

```bash
# 后端
dotnet build ForgeSkin/Backend/ForgeSkin.Backend.csproj -c Release

# 编辑器（开发模式会自动启动上面的后端）
cd ForgeSkin/Editor && npm install && npm start

# 游戏插件（把 <profile> 换成你的 r2modman / Thunderstore 配置目录）
dotnet build ForgeSkin/ForgeSkin.csproj -c Release -p:GTFOBepInExPath="<profile>/BepInEx"
```

舞蹈烘焙需要本机装 **Blender 4.x/5.x + mmd_tools**，在编辑器设置里指定 `blender.exe`。

## 仓库里没有的文件

- `ForgeSkin/Editor/resources/dance/reference.pmx`：舞蹈烘焙用的参考 MMD 模型（鳴潮_鎖暝）。这是第三方模型，不随仓库分发；把它放回该路径后烘焙才可用。
- 人物模型、导出的 `.forgeskin` 包、音乐和发布压缩包都太大或不适合公开分发，本地自行准备。

---

以下是原开源版的说明。

# GTFO Forge Mods

Source code and release notes for NAinfini's GTFO mods, published on Thunderstore.

| Package | Version | What it is | Thunderstore |
|---|---|---|---|
| [ForgeCore](ForgeCore/README.md) | 1.0.0 | The one shared library: asset bundles, logging, settings, pools, networking, input leases and local saves, plus its interface (lobby buttons, pickers, menu pages, HUD), audio (Ogg Vorbis cues, positioned playback) and world-visuals (effects, markers, model loading) parts. | [NAinfini/ForgeCore](https://thunderstore.io/c/gtfo/p/NAinfini/ForgeCore/) |
| [ForgeOrdnance](ForgeOrdnance/README.md) | 1.0.1 | Call-in system: enter a directional code and throw a beacon. Includes the Arsenal (supply pods, turrets, strikes, heavy weapons) and four powered exosuits. | [NAinfini/ForgeOrdnance](https://thunderstore.io/c/gtfo/p/NAinfini/ForgeOrdnance/) |
| [ForgeWeapon_EnergyLab](ForgeWeapon_EnergyLab/README.md) | 1.0.1 | Eight standalone energy guns: beams, chain lightning, charged plasma, explosions, ricochets, flame and gravity control. | [NAinfini/ForgeWeapon_EnergyLab](https://thunderstore.io/c/gtfo/p/NAinfini/ForgeWeapon_EnergyLab/) |
| [ForgeReplay](ForgeReplay/README.md) | 1.0.0 | Records your runs and plays them back in game: free and first-person cameras, team stats and member ratings. | [NAinfini/ForgeReplay](https://thunderstore.io/c/gtfo/p/NAinfini/ForgeReplay/) |
| [ForgeEmote](ForgeEmote/README.md) | 1.0.0 | An action wheel: dances, gestures, callouts, handshakes and fist bumps. | [NAinfini/ForgeEmote](https://thunderstore.io/c/gtfo/p/NAinfini/ForgeEmote/) |
| [ForgePerformance](ForgePerformance/README.md) | 1.0.0 | Raises the frame rate without changing gameplay. | [NAinfini/ForgePerformance](https://thunderstore.io/c/gtfo/p/NAinfini/ForgePerformance/) |
| [ForgeSkin](ForgeSkin/README.md) | 1.0.3 | Applies ForgeSkin packs (textures, attachments, live ammo screens, animated layers) to your own weapons; includes the desktop skin editor. | [NAinfini/ForgeSkin](https://thunderstore.io/c/gtfo/p/NAinfini/ForgeSkin/) |

## Layout

- One folder per package: the plugin source (C#, BepInEx 6 IL2CPP), tests, build tools, README, CHANGELOG and, in each folder's DEVELOPERS.md, how to build against and extend it. Sibling packages reference each other as ../<Package>, so keep the folders side by side.
- Build/ and Directory.Build.props: the shared MSBuild settings (GTFO-API and BepInEx references, warnings as errors) and the release-check scripts.
- Testing/: a test double used by the ForgeCore tests.
- Tools/Vfx/ForgeVfx/: the Unity 2019.4.21f1 project that generates Forge Visual's own effect textures, materials and prefabs from code and builds the effect bundle.
- Large binary assets (model and audio bundles, Unity sources) are not stored here; the Thunderstore packages contain the finished files.

Report problems in this repository's Issues, or find me on the GTFO Modding Discord as **nainfini**. Each package's licence is in its own folder; the effect bundle and its Unity project are CC0.
