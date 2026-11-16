# ForgeSkin for developers

A standalone mod: it depends on ForgeCore and BepInExPack_GTFO only. Game events that other packages also watch come from
ForgeCore `GameHooks` (gear parts spawned, gear spawn completed, enemy damage, reload start and end, dry fire, unwield,
flashlight, glue fire, throw, resource pack, player revived, item spawned, game state, the synced guns' fire, a player's health
arriving) and ForgeCore `GameEvents` (local player down); only methods no other package patches are ForgeSkin's own Harmony
patches in `Native/Hooks.cs` (fire animation, melee attack, mine and sentry placed, the placer's mine-spawned callback, item used, equip, aim, the spawn-complete
overrides of melee, mine, sentry and scanner, item layer, first-person rendering). Each patch class installs on its own and
skips a target whose function start ForgeCore refuses (`Hooks.Unsupported`); one that fails logs `skin-hook-unavailable` and
the rest keep working. The frame tick is ForgeCore `Frame.OnUpdate`; a pack's sounds are one ForgeAudio library
(`AudioKit.Load` from the pack's Ogg bytes, at most 10 s a clip; the sounds of one trigger, for Kill of one enemy (`enemyId`, the `EnemyDataBlock.persistentID` read once from the killed enemy; a kill whose enemy has no group of its own plays the group without `enemyId`), are one group that plays one of them by weight); kept textures and meshes go through `Assets.Keep`; the
settings, picker choices, player colours and readback files go through `Settings` and `Store.WriteText`; wear counts through `Store.Read` / `Store.Write` at their own path.

What ForgeSkin draws goes through ForgeCore's visual and UI parts: a pack's precompressed texture through `Images.QueueRaw`, a
pack's PNG or JPEG through `Images.Queue` (the options of `ImageTextures.Decode`)
(normal maps in the game's DXT5nm layout), a pack's SFM1 mesh through `MeshArrays.Build` (the reader of the format stays in
`Core/`), every emission write through `Glow` (`Write`, `SetColour`, `Clear`), gear icons through `GearIcons.Redraw` and `Unframed`, and
the picker through `UIKit` (`PickerSource` and a lobby button), code effects through `Procedural` (below). Texts are in
`lang/en.forge` and `lang/zh.forge` beside the DLL. What stays here is ForgeSkin's own: the pack format, the skin targets,
live screens, animated layers, trigger effects, casing pools and the part layout.

## What is skinned

Every gear instance by its owner: a gear built from parts waits (`SkinnedGear` pending list, looked at four times a second for as
long as it exists) until its item's `Owner` (`PlayerAgent`, then its `SNet_Player`) is known. The local player's gear (first and
third person) wears their own choices; a teammate's (third person, and the sentry they placed) wears their synced look (below);
a bot's stays vanilla; an icon or lobby preview, which never gets an owner, is skinned only on the icon and menu paths. The key is
(owner, gear id): two players with the same gun each show their own skin, colours and changes. Every look goes through
`SkinnedGear` (apply, revert, wait for the skin to load, release after 30 s unused).

- **Placed sentry.** `SentryGunInstance` is spawned from the gear's `GearIDRange` and builds its own parts: it is skinned where
  its parts spawn like any gear, by its `Owner` (set in its `OnSpawn`). Picking it up destroys it.
- **Placed mine.** The deployer's (or consumable mine's) `OnStickyMineSpawned` callback, run for the placer only, hands over
  the spawned `MineDeployerInstance`; it wears the deployer's skin key, materials only (its model is its own prefab).
- **Dropped magazines.** A gun's 5 drop copies (`BulletWeapon.m_magDropPool`, made once in its `OnGearSpawnComplete` from the
  magazine under `m_aMag`) are the gun's own and reused oldest first; the gun's apply swaps their slots by the same material rule
  to world-projection copies of its looks, and its revert puts the game's materials back.
- **Pickups.** `GameHooks.ItemSpawned` in pickup mode (level pickups, container contents, dropped items): a pickup whose item
  has a skin (`item:<ItemId>`) is skinned on its object, materials only, and keeps it while picked up and dropped again. Every
  pickup of the level is listed so a pick or reload reaches it; one that loses its skin goes back to vanilla.
- A placed mine or a pickup shares only some materials with the item the skin was made for; Development logs every slot as
  `swap` or `kept`. A teammate's mine is reported to its placer only and stays vanilla; a pickup with no owner wears the local
  player's choice.

## Teammates' looks

`Native/Looks.cs` shares each player's look through ForgeCore `Net` (channel `ForgeSkin`, lobby value `look`: each player writes
only their own; ForgeCore sends it to every player with the same ForgeSkin, again to one who joins later or after a host change,
and forgets the look of one who left). ForgeSkin never calls NetworkAPI and touches no vanilla message. The bytes are
`Core/Look.cs` (the layout is in its header comment): version, flags, the character entry (skin number 0 when no character is
picked), then per gear of the loadout that has a skin of its own (at most 8): gear id, skin number (FNV-1a 32 of the skin id),
content hash (FNV-1a 64 of the `.forgeskin` file, read on a worker and kept with the loaded skin), the Thunderstore mod folder it
came in, the wear stage reached and the player's changes that differ from the author's (a player colour in 4 bytes, a code-effect
number or transform entry in 3, an effect colour in 5). A whole value is at most 6 KiB; a larger or unreadable one is dropped and
logs `skin-look-malformed`. The local look is written half a second after the last pick, colour or adjustment, and within a
second of a gear of the local player's being built (a loadout change builds the new gear; the backpack is read only then) or a
wear stage moving; the same bytes are never sent again.

A teammate's gear wears their skin when the same pack is installed here (same number, same content hash, the skin made for that
gear) with their changes (`Look.Fit`); otherwise it shows its original look and logs one line per player and skin
(`skin-look-missing`, `skin-look-mismatch`, `skin-look-bad-value`), and the picker's details list it with the player's name, the
gear and the Thunderstore mod to install. The local player's global skins are not put on a teammate's gear. On it, the ammo
screen, low-ammo, empty, ammo pickup and aim end are drawn as the menu preview draws them (no reads of this player's backpack or
hands); code effects draw while it is in its owner's hands; its sounds play at the gear (3D) for what this machine sees: the shot
(`GameHooks.Fire.BulletWeaponSynced` / `ShotgunSynced`), wield and unwield, going down and getting up (the player's health
arriving through `GameHooks.HealthSetReceived` falling to 0 or rising from it). The vanilla shot sound stays.

## Character models

A character skin is a skin document with `character` (target `character`); its format is defined only in `Core/Character.cs`
(the header has a full example) and checked by `SkinPack.Validate` (`bad-character-*`) and, when the model is read,
`CharacterRig.Matches` (the descriptor's hashes) and `CharacterRig.Check` (the bone map against the model's rest pose, ForgeCore
`RigMap.Check`). A character pack is its own Thunderstore mod depending on ForgeSkin, found as gun packs are. `Native/Characters.cs`
wears it, all through ForgeCore: the model is built once by `ImportedModels` (format 2, `Skin.BuildCharacter`, its pictures decoded
over earlier frames with `ImportedModels.Prepare`), hung on the body's animator with `PlayerLooks.Hang`, scaled to the body's height
times the author's `height` (`Characters.Fit`: `CharacterRig.Stature` against the body's bind-pose head and feet; spring radii,
capsule radii and gravity scale with it), drawn on the layer of the body's first active mesh (the lobby figure keeps inactive spares
on a layer its camera does not draw), posed by `Models.CopyPose` over `HumanRig.Links` and `HumanRig.ArmReach` with `Follow`, its spring
chains bound with `Chains.Bind` at rest (capsules on the mapped joints), and the original person hidden with `Persons.Hide`
(`Look = true`). The local player wears their own pick, a teammate the character entry of their look (same pack and content, else
the original person), a bot always the original; who wears what is put right twice a second only after something changed
(`Characters.Dirty`). A model that cannot be built or posed leaves the original person and logs `skin-character-failed` once.
The local player also sees the model's own arms in first person: a second instance of the model worn on the game's first-person arms
with `Models.WearFirstPerson` (`HumanRig.ArmWear`, `Hide = BodyParts.Arms`, `Descendants`, the `hide` materials as `LeaveOut`), so its
hands and fingers are the game's on the grip; when it cannot be built the game's own arms stay (ForgeCore logs why). The author's
`height` does not touch these arms: each bone sits on the game's first-person bone, scaled to the game's arm lengths
(`WearSolver`), which is what keeps the hands on the grip.

ForgeSkin is ForgeCore's player look provider (`PlayerLooks.Provide`): `Describe(player)` is that player's shared look (character and
gear skins); `Dress` resolves a look against the installed packs as a teammate's is, wears its character on the given body and
returns a dress whose `Hold(item)` puts the look's skin on a weapon the body holds (a look with gear skins alone still dresses).
Materials the author marked `shader: toon` are drawn through ForgeCore `ToonDress` with their `params` (`Toon.Apply`; unknown names go to the author
log), in the lighting this machine's `Toon` setting picks (`Forward`, `Deferred`, the default, or `Off`: drawn lit). The setting is a
local display preference, never in the look sent to others; a change re-dresses every worn model at once (`Characters.ToonChanged`).
A cut-out material (`cutout`) draws with ForgeCore `LitCutout`, or clipped in either toon entry. `CharacterRig.Matches` ends with
ForgeCore `ImportedModelDescriptor.CheckFiles`, the same check the game build runs, so the editor's export refuses what the game
would. Not yet: a separate first-person arms model (`arms.model`: one warning, the model's own arms are worn), player colours on
character materials and a slot icon of the character worn.

## Picker and player colours

The picker opens in the lobby's loadout pop-up, from the SKINS lobby button (there is no key), as one screen without tabs
(ForgeCore's grid layout, side panel and title bar gear). Left, one slot per gear or item that has a loaded skin (a tick on
those wearing one); middle, a grid of its looks, the original look first, a press wears it (kept in
`BepInEx/config/ForgeSkin.choices.json`); right, the details of the card under the cursor over the panel of the skin worn.
The panel's colour schemes set the player colours (`playerColors`) of that skin: 原色 (every `default`), each of the
document's `colorSchemes` (`{id, name, colors: {playerColorId: sRGB}}`, a colour left out keeps its default), and 我的, chosen
when the colours worn match no scheme; pressing 我的 opens, under the scheme cards, a swatch row per colour named as the author
named it (its default and eleven hues at the default's saturation and brightness). A scheme writes each colour (the default as none), so the look and the colours file
are as before. A character has no colour schemes. Colours are kept per skin ID in
`BepInEx/config/ForgeSkin.colours.json`, written 0.5 s after the last change; a pick paints a copy of the skin document (`Skin.Painted`) and live gear takes it on
the next tick, as a skin pick does. The picker does not open inside a level. Its details add, in the warning colour, that the game's texture quality is below
full (`QualitySettings.masterTextureLimit`: every mipmapped skin texture drawn at half or a quarter), and, in the alert
colour, each pack the last reload rejected with its reason (`Skins.Failed`: version, bone map, unsupported material, file in use, else
damaged), and, in the warning colour, that packs left in the old `plugins/ForgeSkin/skins` folder are not loaded. The title
bar's gear opens ForgeSkin's settings in the panel: the two switches and the toon choice (前向 / 延迟 / 关闭).

A gear with several installed skins (several packs for one target, or an editor gun pack) lists them all, each card with the
skin's name and its author when the pack has one; the character slot shows the avatar icon, and a gear slot tile shows the
gear's game icon (`GearIconRendering.TryGetGearIconSprite`), which ForgeSkin redraws in the skin it wears. Which skin a target wears, first match
wins: the picker's choice (ignored while that skin is not installed for the target; "" is the original look), `active.json`
`targets`, then the first pack by path among skin mods and registered packs. The editor's 应用 alone goes before the
picker's choice: the backend (`pack.install` with `pick`) leaves a one-shot `<ticks>.pick` (`{"target", "skin"}`) in the skins
folder, and the plugin's next reload writes it into its own choices and deletes it; a pack put in by hand or another change to
`active.json` does not, and a skin it names that a choice keeps off is reported in `forgeskin.log`. Global skins (`active.json` `global`) are on every
gear under its own skin (the gear's skin wins on a material both cover); the picker neither lists nor removes them, so the
original look removes only the gear's own skin, and its details say how many global skins stay. Choices, colours and changes
of the gear's own skin reach teammates through the look (above); a skin allows at most 8 player colours (`too-many-player-colors`).

`Native/Previews.cs` shows each skin card the picture its pack carries, drawn by the editor when it packed the skin (a gear
skin's `picture`, a character's `character.picture`): read from the pack and decoded off the main thread (`Images.Queue`), only
uploaded on the main thread; the skin is not loaded for it and nothing is rendered or photographed in the game. The picture is
what the author packed: colours a player picks show on the gear and the character in the lobby, which the details say for a
skin with player colours. A pack without a picture (packed by an older editor) gets a placeholder (the avatar icon for a
character, none for a gear) and the details ask for it to be exported again with the new editor. The original look shows the
avatar icon for the character and the gear's game icon while the gear wears no skin of the picker's. Pictures are kept per pack
while it is installed, at most 24. On every gear the icon renderer builds, a
skin's attachments are left out of the icon's framing (`GearIcons.Unframed`), so a skinned gear's icon is framed as without
its skin.

The panel's 调整 section lists, for the skin the slot wears, every code-effect value its author marked for players (`playerTweaks`): a
`UISlider` per number or transform entry and a `UISwatches` row per colour (the skin's value and eleven hues). A change is kept
under `fx:<effect>/<param|color|transform>/<name>` in the same skin's entry of `ForgeSkin.colours.json` (one number, or sRGB
RGBA), written 0.5 s after the last change; live gear re-reads it through `Skins.TweakVersion`.

## Code effects

`Native/CodeFx.cs`. The document's `codeEffects` are checked against ForgeCore's program catalogue (`Core/CodeEffect.cs`,
`CodeEffects.Validate`; the plugin sets `CodeEffects.Catalog = Procedural.Catalog`, the backend reads the same embedded
`fx-programs.json`). One `ProceduralLook` per effect; `CodeEffects.Resolve` fills it from the document and the player's
values, only where the author allowed them.

- **On a material.** One `FxCanvas` per skin material and channel: a RenderTexture of the texture's size and its painters exist only while the gear is held; on a frame with an active effect the
  base (the skin's texture after its animated layers, or the original) is copied in, then each active effect is painted over
  it with `Procedural.Painter(..., over: blend)` per mesh and submesh that uses the material, in document order, then mips.
  The canvas replaces the texture on the material and gives it back on release; a wear stage that swaps the base rebases it.
- **On an attachment.** A copy of the attachment's mesh 1 % larger about its bounds centre with a `Procedural.CreateMaterial`
  material; each frame only `Procedural.SetTime`, `ProceduralLook.Apply` when its version changed.
- **When.** Only while the gear is held: first person when wielded, third person for the same gear as the local wielded one
  while a renderer is visible, the lobby preview; not icons. Event effects (`trigger` other than `always`) draw for
  `seconds` after the event, then one more frame to restore the base. Canvases and painters are released when the gear leaves the hand,
  and everything when the skin is reverted or removed.

## Holograms

`Native/Holograms.cs`, `AmmoScreen.cs`, `SkinnedGear.Surface`. The game's `Cell/Player/Display_Hologram` has `_EmissiveMap` and
`_EmissiveColor` but no `_MainTex` or `_Color`: an attachment's picture goes to `_EmissiveMap` when the shader has it, else
`_MainTex`, and `hologram.opacity` multiplies the glow gain. The editor bakes `hologram.color2` into the attachment's picture
(`.frames/<id>-hologram.png`) and turns `scanlines` and `edgeGlow` into code effects on the attachment (ids `<id>~scan`,
`<id>~edge`) when it builds the pack; they count toward the 8 code effects. `SkinPack.Validate` checks `flicker`, `opacity`,
`scanlines` and `edgeGlow` in 0..1 and `color2` as an RGB vector (`bad-vector`).

## Charms

An attachment's `charm` hangs its model and screen on a rope generated in code, from the attachment's origin (its -Y the
rest direction); the model hangs by its own origin. At most 4 charms on one gear; `SkinPack.Validate` rejects a value out of
range with `bad-vector`.

| Field | Default | Range | Meaning |
| --- | --- | --- | --- |
| `length` | 0.05 | 0.005–0.3 | Metres from the hanging point to the pendant |
| `segments` | 6 | 1–12 | Pieces the rope bends in, none shorter than 5 mm |
| `weight` | 1 | 0.1–3 | The charm's mass: heavier swings longer, lighter settles sooner |
| `damping` | 0.3 | 0–1 | 0 swings long, 1 settles at once (critically damped) |
| `stiffness` | 0.25 | 0–1 | 0 limp rope, 1 stiff wire that keeps the attachment's -Y |
| `style` | `Chain` | `Cord`, `Chain`, `Beads` | Smooth tube, alternating oval links, or beads |
| `thickness` | 0.002 | 0.0003–0.01 | Metres: cord diameter, link width or bead diameter |
| `color` | [0.8, 0.8, 0.82] | 3 values | sRGB of the rope |
| `collide` | true | | Keeps the rope out of boxes taken from the gear's part meshes |

The rope moves by ForgeCore's one chain physics (`ChainState`, `ChainSpec.Charm`: Verlet at a fixed 1/240 s step, riding
along with 85% of the player's body move; see ForgeCore's `DEVELOPERS.md`); `Core/CharmRope.cs` builds the charm's chain
(hanging point, `segments` pieces, the pendant four times as heavy on a rigid arm), passes the author's values and draws the
rope mesh and the pendant's pose. The plugin passes the first-person camera's position as the body. The editor computes no
rope: the 3D view sends the hanging point's path for a preview motion (or one frame at rest) to the backend's
`charm.simulate`, which runs this same `CharmRope` on ForgeCore's linked `ChainPhysics.cs` and returns each frame's mesh and
pendant pose for the view to play back. ForgeCore's `Mods/ForgeCore/tests/Core/ChainChecks.cs` locks the trajectory. Only the charms on
the gun in the local player's first-person hands move; third-person, menu and other players' guns hang still. Nothing is
synced.

## Character tab (editor)

The editor's 人物模型 tab (`Editor/src/renderer/character/`) reads a skinned `.glb` with three.js, matches its bones to the
canonical humanoid with the site's own matcher (`Web/src/forge/animation-bone-match.ts`: `matchHumanBones` for the body,
`matchHumanFingers` for the 30 finger joints) and holds the match to ForgeCore's rig check through the backend:
`character.check { joints }` (canonical joint to rest position, game axes) returns the joints of `CharacterRig.Required` it lacks,
`RigMap.Check`'s findings as kinds the editor words itself, whether the body faces backwards, and which hands keep their fingers.
Spring bones are previewed like charms: `springs.simulate { chain, nodes, strands?, frames }` runs ForgeCore's linked
`ChainPhysics.cs` with the document's own `SpringChain` (its `Spec()` is the preset with the author's values) on the anchor bone's
path for a preview motion (`viewport/motion.ts`, shared with the charm preview) and returns node positions per frame;
`springs.presets` gives each kind's starting values. Exporting a character pack is not wired yet.

The motion row under the preview plays moves the way the game does. A clip plays on a hidden canonical body, the skeleton the
action file carries, and the model copies that body's pose every frame (`character/clips.ts`).
`character.links { bones, fingers }` returns, per canonical joint, the link ForgeCore's `HumanRig.Links` gives (`toward`, `from`)
and whether `PoseSolver.Skipped` leaves it out; it also returns `HumanRig.ArmReach` as `[upper, lower, end, anchor]`. The copy is
the site's port of `PoseCopy`, `Web/src/shared/render/imported-skin-pose.ts` (`createSkinPose`; its optional `reach` bends those
limbs as `LimbReach.Bend` does). While a move plays, the springs run through the same frames (`simulate(motion, clip)` in
`character/model.ts`). With no move or preview motion they run 8 s held still from the bound pose, so hair and skirts drop under
gravity and come to rest as in the game; the last frame then holds.

The clips are listed in `character/motions.json`: game player actions by name in the site's `player-actions.json`, plus Mixamo
clips from `Mods/ForgeEmote/Assets/Clips`. `pnpm ts Tools/Models/stage-skin-motions.ts` copies them into the
editor's `motions` folder beside `character` (not in Git), and the editor bundles that folder. `build-editor-release.ps1` runs the copy before
packaging. A clip that has not been copied is hidden from the row.

## Other packages on the same gun

- A gun whose model a package mounts with ForgeCore `GunMount` (EnergyLab's guns, Workshop gun models) is not skinned:
  `GunMount.Of(holder)` names it, and `GunMount.Mounting` puts a skinned gun back to its own look before the mount reads
  its poses and hides its parts. Part mounts (`GunPartMount`) are not excluded; a skin and a mounted part share the gun.
- Gear icons: ForgeSkin redraws only the icons of gear whose skin or colours changed (every gear when a global skin did); a
  package that supplies its own icons (`GearIcons.Supply`) draws them again itself.
- Ejected casings: ForgeSkin appends its own pools after the game's in `WeaponShellManager.SetupPools` and points a skinned
  gun's casing type at its pool while it ejects; ForgePerformance's casing limit counts and drops those casings like the
  game's, before any casing is taken from a pool. `Shells` holds a reference to each pool it builds and stores into the
  game's pool array with the collector's write barrier (`Shells.Put`): the game runs the incremental collector, and an
  Il2CppInterop array indexer store alone lets it free a pool the array still points at. A slot without a pool of ours
  points at one of the game's pools, never at a pool that was not set up.
- ForgeSkin installs no patch on a method another package patches; shared game events come from `GameHooks`.

## Build

```
dotnet build Mods/ForgeSkin/ForgeSkin.csproj -c Release --artifacts-path artifacts/dotnet -p:GTFOBepInExPath=<profile>/BepInEx
python Mods/ForgeSkin/tools/package_release.py --artifacts-path artifacts/dotnet --output <folder>
```

The pack reader (`Core/`) is compiled into `ForgeSkin.Plugin.dll`; the zip holds that one DLL, `lang/` and the metadata.

## Adding packs

- Put `.forgeskin` packs in `BepInEx/ForgeSkin/skins` (`ForgeSkin.Format.SkinFolders.Skins`), wherever the DLL is installed
  (a mod manager puts it in `plugins/NAinfini-ForgeSkin/ForgeSkin/`); the editor installs there, and `active.json` there
  picks the skin per target. ForgeSkin 1.1.0 and earlier used `BepInEx/plugins/ForgeSkin/skins`; the editor moves what it
  finds there (`Backend/OldSkinMove.cs`), the plugin only reads the new folder and, while skins are left
  in the old one, says so in the picker (a player's state, not an error). Both go at 1.4.0 (`Docs/forge-skin/PLAN.md` §6).
- Or ship a mod folder directly under `BepInEx/plugins` with a `forgeskin.forge` marker (`SkinPacks.Marker`) listing its packs,
  one path per line relative to that folder; blank lines and `#` comments are skipped.
- Or call `ForgeSkin.Plugin.SkinPacks.Register(path)` from your plugin's `Load`.

A pack the reader refuses is not loaded and logs `skin-pack-rejected` with the reason code of `SkinFormatException`
(`bad-audio`, `bad-image`, `bad-mesh`, `missing-file` and the others).

A MetallicSmoothness texture is in the game gear shader's layout (`Cell/Player/CustomGearShader`, as the game's own gear
textures): metallic in R, smoothness in G. A material's or attachment's glow (`EmissiveColor` x `EmissiveIntensity`, effect
flashes, unlit pictures) is in "as itself" units, as the editor previews it; it reaches the game's `_EmissiveColor` times
`MaterialParams.EmissionUnit` (0.01, the gear shaders' measured emission gain) for white; its colour is sRGB like every skin
colour, and ForgeCore `ColourSpace.Glow` (`Glow.Value` in game) works out the value so the shader gets the picked hue whether the property is `[HDR]` (set as it
is) or a plain colour (Unity converts it from sRGB). With no `EmissiveColor` the intensity scales the game material's own glow colour.

A texture set straight on a material (a material's, a wear stage's or an attachment material's, not a layer atlas) is a
PNG, a JPEG or a precompressed DDS (`Core/Dds.cs`), told apart by its header: a standard DDS with the DX10 header, BC1 when
opaque or BC3 with alpha and for normal maps (DXT5nm), sRGB in the DXGI format, Unity's full mip chain with rows from the
bottom, both sides multiples of 4 up to 8192. The editor writes every such texture as `textures/<name>.dds` only (a PNG
when a side is not a multiple of 4) and the manifest names that file; a layer atlas must stay a PNG or JPEG (`bad-image`
otherwise). A layer's frames are its `TargetRect` region at full size, or, where they would not fit a 4096 atlas
(`PackBuilder.AtlasLayout`), smaller by one scale for both sides (never larger, `bad-atlas`); the plugin copies a full-size
frame with `Graphics.CopyTexture` and stretches a smaller one onto a region-sized RenderTexture with `Graphics.Blit` first. The plugin uploads a DDS as it is after checking its header, sizes, mip count, block length and sRGB against
the channel (`bad-image` when any is off), and decodes a PNG or JPEG as before. The document schema stays 1, so packs made
with PNGs still load; ForgeSkin 1.0.3 cannot read a pack with DDS textures.

A reload reads and checks each pack's manifest only. A skin's files are read when a gear first wears it (`Skins.Ready`):
a worker thread reads the zip, the SFM1 meshes and checks the precompressed textures, the main thread builds the meshes and the
audio library and queues the textures on ForgeCore: a precompressed one on `Images.QueueRaw` (uploaded as it is), any other
on `Images.Queue` (decoded and compressed in the game). Until every skin a gear wears is loaded the gear keeps its look and waits; a picture,
mesh or sound that does not decode rejects the pack then (`skin-pack-rejected`), and a pack whose file changed since its
manifest was read is read again first. A skin no gear shows or waits for is freed after 30 s (`Skins.Release`); a replaced
or removed one as soon as no gear shows it.

## Logs

Errors go to `BepInEx/LogOutput.log` through ForgeCore `Log` under their registered codes. With `Development` on, the plugin
also writes `BepInEx/ForgeSkin/forgeskin.log` (`<UTC time> info|warn <message>` per line, cleared at launch), which the editor reads
as its game feed; with it off no file is written and info lines are dropped. Each skin applied lists every renderer slot
of the gear: `swap <path>[slot] mesh '<mesh>' <material>#<id> -> <look>` (with `(skin target '<name>')` when the slot took
the look through the material object it shares with a matched slot, or through its mesh name) or `kept ...: no skin target
'<name>'`. A material override covers every slot showing that material object, as in the editor.

## Editor control by an AI agent

Started with `--ai-control` (optionally `--ai-control=<port>`, 1024 to 65535, default 9333) or with the environment variable
`FORGESKIN_AI_CONTROL` (a port, or `1`), the editor opens the Chromium DevTools protocol on 127.0.0.1 only and offers the
structured interface `window.forgeAI`; without either no port is open and `forgeAI` does not exist. An invalid port is ignored
with one `ai-control` line in `GTFO_UserData/logs/app.log`. The flag is read before the app is ready and has no effect on the
Squirrel install, update and uninstall runs. The editor has no single-instance lock, so close an editor that is already open
first (two copies share one data folder). All three copies run the same compiled code (the flag is read in `main.ts`, the
interface is an ordinary renderer module loaded on demand); an installed copy starts with
`%LocalAppData%\ForgeSkin\ForgeSkin.exe --ai-control` (Squirrel's launcher forwards arguments), a portable copy with
`ForgeSkin.exe --ai-control`, a source run with `pnpm start -- -- --ai-control` in `Editor/`. In this mode the window also keeps
rendering when covered or minimized (`backgroundThrottling` off). Every file dialog is the system's: the main process asks for
paths through one function (`pickPaths` in `main.ts`), and since a protocol client cannot drive the system's dialog, an agent
answers the next dialog beforehand with `forgeAI` `pickNext {paths}`; that dialog then does not open, and nothing is shown in the
window for it.

`Editor/src/renderer/aiControl.ts` is the interface: `forgeAI.state()`, `command(name, args)`, `patch(ops)`, `get(path)`. Every
call answers `{ ok: true, ... }` or `{ ok: false, code, message }`. It adds no logic of its own to the document: commands call
the store and livery actions the UI calls (`edit`, `addLivery`, `addLayer`, `duplicateAttachment`, `importMesh`, `applyToGame`,
...), so validation, one undo step per command and autosave are the UI's. `patch` is generic over the skin document (paths with
`key=value` array selectors; set, add, remove, merge in one edit), so a field or layer kind added to the document needs no
change in `aiControl.ts`; a new command is added only where the UI has an action with no document-field equivalent (placing a
decal by UV, the camera, a render, the UV islands). `command('help')` lists every command with its arguments, and the command
table, paths and reason codes are in [AI-GUIDE.md](AI-GUIDE.md), the agent's operating guide (that file also holds the UI route:
screen map, main flow, file handling, limits).

## Skins library interop

`Backend/SkinsFormat.cs` reads and writes the skin group format of the Skins library (food-Skins; format and source at
git.takina.io/gtfo/skins): `manifest.skingroup.json` plus `*.mattarget.json`.

- Backend method `skins.import { manifest, root, weapon?, lang }` writes one project per gear the group names into
  `root/<item id>/<skin id>.forgeskinproj` (the editor's autosave folders), texture macros as PNGs in `<skin id>.textures/`
  beside it (deleted with the project). Gears come from `filterGroups` (and the legacy flat `filters`, one more group):
  `OfflineGearPersistentID` → `SkinTarget.GearId`, `ItemPersistentID` → `SkinTarget.ItemId`, type as name or number.
  A material target goes to every gear that has its material and whose game texture names (`SkinsFormat.Materials`:
  shader and slot → texture name per material, read from the game files) fit its `match_groups` / `matchGroups` /
  `texture_names`; the first fitting target of a material wins, as in Skins. A group naming no gear returns
  `needsTarget` and writes nothing until a `weapon` is given. The result's `notes` (`SkinsNote` kind, skin, what, count)
  list everything left out or changed; the editor words them by `skinsNote.<kind>` (`ui/SkinsReport.tsx`).
- `pack.exportMod { …, format: "skins", gunPack }` writes the built packs as one group (`gunPack`, one pack per gear) or one
  group per pack. Item skins are skipped, a material's last override is written (the plugin uses the last too), material
  targets name the gear's texture names where another gear of the group has a material of that name, a BlendHS material
  with a picture gets `shader: Cell/Player/CustomGearShader` and macros for the slots the plugin fills, an emissive
  texture writes `_EnableEmissive`. `dropped` carries the same notes.
- `project.listAll { root }` lists every item's skins for the export dialog.

## Editor data folder and editions

`Editor/src/main/dataDir.ts` is the only place that decides the data folder; the backend gets it as `--data-dir`, and the
app log, dialog memory, write checks and the window (`app:dataDir`) ask `dataDir()`. `scripts/gen-types.mjs` runs the
backend on a throwaway folder. The edition comes from where the app runs:

| Edition | Recognised by | Default data folder | Updates |
| --- | --- | --- | --- |
| dev | not packaged | `Editor/GTFO_UserData`, fixed | none |
| installed | exe in `<install>/app-<version>/` | `Documents\ForgeSkin` | Squirrel feed |
| portable | packaged, anywhere else | `GTFO_UserData` beside `ForgeSkin.exe` | none, no Squirrel start-up handling |

Settings → data folder picks another folder (installed and portable). The choice (`dir`) and the folders the data was
moved out of (`former`) are kept in `data-folder.json`, never in the data folder: the installed copy's in its Electron
profile (`%AppData%\ForgeSkin`), the portable copy's beside `ForgeSkin.exe`, where a folder inside the exe's folder is
written relative to it, so a portable folder copied elsewhere still finds its data. `moveData` stops the backend and file watches, copies, checks that every file arrived with its size, switches,
then deletes the old folder; on failure it removes its copy and the old folder stays in use. An empty or new folder takes
the copy, a folder that already holds ForgeSkin data (`settings.json`, `autosave/` or `logs/backend.log`) is used as it is
and the old one is left alone, any other non-empty folder is refused. The window saves its open skin first and reloads
after a move. An installed copy that finds `<install>/GTFO_UserData` (versions up to 1.1.0) moves it to its data folder
the same way at start, before the backend starts; when that fails it keeps the old folder as its data folder.

Projects store files under their own folder or the data folder relative to the project file, so autosaved skins move
with the data folder. A project saved outside it that names a data file (a sticker, a shape, the tutorial sample) holds
that path relative to itself, which points into the old folder after a move. The editor passes every `former` folder to
the backend (`--former-data-dir`); `Projects.Load` takes a named file that is gone and lies under a former folder from the
same relative place in the current data folder when it is there, and the next save writes the new place. Nothing else is
guessed: a file found in neither place stays as named and building and the pre-export check name it as missing. Only the
project file holds relative paths: `Load` and `Save` convert, and every document the backend gets (`project.save`,
`project.missing`, `project.files`, `pack.build`) must name its files by absolute path, else `bad-request`
(`Projects.Absolute`).

## Editor release

One release is the plugin's Thunderstore zip and the editor's Squirrel installer and portable zip. They have separate version
sources: the plugin and its zip use the ForgeSkin row of `Mods/Release/release.json` (`pnpm ts Tools/Forge/set-package-version.ts
ForgeSkin <x.y.z>` writes it into `manifest.json` and the code), the editor uses `Editor/package.json`; each is checked against its
own source, and the two need not match. Build it from the repository root with a BepInEx IL2CPP profile for the game references:

```powershell
pwsh Mods/ForgeSkin/tools/build-editor-release.ps1 -BepInEx "$env:APPDATA\r2modmanPlus-local\GTFO\profiles\Forge-Multiplayer\BepInEx" [-Output <dir>] [-SkipMake]
```

The script, all under `<Output>` (default `artifacts/forge-skin-release`):

1. builds `ForgeSkin.csproj` in Release (ForgeCore builds with it) into `dotnet/`;
2. writes the ForgeCore and ForgeSkin Thunderstore zips into `thunderstore/` with each package's `tools/package_release.py`
   and checks them with `Mods/Build/verify_release.py`;
3. publishes the backend (`Backend/ForgeSkin.Backend.csproj`, .NET 10, self-contained single file) into `publish/`;
4. stages the plugin the installer carries: `publish/plugin/ForgeSkin/` (`ForgeSkin.Plugin.dll` and `lang/`) and `publish/plugin/ForgeCore/`
   (the ForgeCore zip unpacked);
5. runs `pnpm install --frozen-lockfile` and `pnpm make` in `Editor/` with `FORGESKIN_PUBLISH_DIR` set to `publish/`, which
   `forge.config.ts` ships as the app's `resources/publish` (the prePackage hook refuses to package without it);
   Squirrel writes `ForgeSkin-<version> Setup.exe`, `ForgeSkin-<version>-full.nupkg` and `RELEASES` into
   `Editor/out/make/squirrel.windows/x64/`; the script then zips the packaged app `Editor/out/ForgeSkin-win32-x64/` into
   `ForgeSkin-<version>-portable.zip` (.NET's ZipFile) and checks it (it holds `ForgeSkin.exe`, `resources/app.asar`, the
   backend and both plugins under one `ForgeSkin-win32-x64/` folder, and no `GTFO_UserData`, `data-folder.json` or `Update.exe`);
6. copies the files to upload into `upload/` and lists their SHA-256 in `upload/upload.sha256`.

`-SkipMake` stops after step 4; `-PluginOnly` skips step 3 too. The installer is not code-signed. Nothing is uploaded; the upload steps and the fixed update
feed (`ForgeSkin-update` release of NAinfini/GTFO-Forge-Mods) are in `Mods/Release/README.md`.

In a checkout the backend installs the plugin from `artifacts/forge-skin-release/publish/plugin` (`Install.PluginSource`),
so run the script, at least with `-PluginOnly` (steps 1, 2 and 4 only; `-BepInEx` defaults to `GTFO_BEPINEX_PATH`, else the
Forge-Multiplayer r2modman profile), after changing the plugin. `pnpm start` runs that itself when the staged plugin is missing
(`artifacts/` gets cleaned). The script stages `publish/plugin` in a sibling folder and swaps it in whole, so an interrupted run
leaves no half folder. Installing into a profile deletes the
`ForgeSkin.Format.dll` and `NVorbis.dll` that 1.0.3 and earlier left in `BepInEx/plugins/ForgeSkin/`. When the mod manager
installed the plugin (a `ForgeSkin.Plugin.dll` elsewhere under `BepInEx/plugins`), the editor keeps that copy and deletes
its own `ForgeSkin.Plugin.dll` and `lang/` from `plugins/ForgeSkin/`, so one copy loads; a managed copy older than the
shipped one makes the install fail with `forge-skin-old`. Without a managed copy it copies `ForgeSkin.Plugin.dll` and
`lang/` to `plugins/ForgeSkin/`. ForgeCore is left to the mod manager: a profile that has `ForgeCore.dll` anywhere under
`BepInEx/plugins` keeps it, and one older than the shipped copy makes the install fail with `forge-core-old`; a profile
without ForgeCore gets the shipped package in `BepInEx/plugins/NAinfini-ForgeCore/`. Uninstalling removes only the
editor's own plugin copy and its `lang/`; the skins folder and a managed copy stay.
