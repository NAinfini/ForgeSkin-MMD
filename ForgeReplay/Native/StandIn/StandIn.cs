using System;
using System.Collections.Generic;
using ForgeAudio;
using ForgeCore;
using Gear;
using Player;
using UnityEngine;

namespace ForgeReplay;

/// <summary>A player's body shown with no player behind it, made the way the game makes every player's third-person body (<c>PlayerAgent.Setup</c>,
/// and the lobby's figure, <c>CM_PlayerLobbyBar.SpawnPlayerModel</c>): an instance of the game's player rig (<c>m_rigBaseForClothes</c>) dressed
/// through <c>RuntimeRigSwitch</c>, as an ordinary object with no <c>PlayerAgent</c>, no <c>SNet_Player</c> and no script of the game but its
/// third-person IK. Whoever holds it says everything it shows: where it stands and looks (<see cref="Pose"/>), which state each layer of the game's
/// body controller plays and since when (<see cref="Play"/>), how it looks (<see cref="Dress"/>: the recorded clothes, then a look worn through
/// ForgeCore's player looks), the weapon or other thing in its hands (<see cref="Hold"/>, <see cref="Covered"/>), its flashlight, voice and muzzle
/// flash. It reads no input and no network state, so pausing, a changed speed and a jump in time are the animator's speed and the time a state is
/// entered at. <see cref="Visible"/> is the one switch that shows or hides it; <see cref="Version"/> changes whenever what it draws changes. This
/// folder knows nothing of who uses it. Main thread only.</summary>
internal sealed class StandIn : IDisposable
{
    private readonly GameObject _body;
    private readonly Animator _animator;
    private readonly Action<string, string> _note;
    // The float parameters of the game's player controller (PlayerBaseRigController, read from its asset). The game no longer has Animator.parameters to list them.
    private static readonly int Forward = Animator.StringToHash("MoveBackwardForward"), Right = Animator.StringToHash("MoveLeftRight"), Crouch = Animator.StringToHash("Crouch"), AimPitch = Animator.StringToHash("AimDownUp");
    private float _crouchValue, _forward, _right, _aim;
    // The rate the game's own PlayerLocomotion.UpdateFullBodyAnimValue moves the walk values at; the crouch and the aim follow at CrouchRate.
    private const float WalkRate = 7.5f, CrouchRate = 6f;
    private Quaternion _yaw = Quaternion.identity;

    // What each layer was last told to play. A state the layer has left by itself for longer than WrongSeconds is entered again once; one the controller
    // does not have is then left alone until the next state.
    private struct Layer { internal int State; internal long StartMs; internal float Weight, Wrong; internal bool Told, Retried, GaveUp; }
    private const int Layers = 16;
    private const float WrongSeconds = 0.25f, WeightRate = 10f;
    private readonly Layer[] _layers = new Layer[Layers];
    private bool _moved;
    private readonly HashSet<(int Layer, int State)> _gaveUpOn = new();

    // The weapon in the hands: the rig's hand socket (PlayerSyncModelData.ItemAlign, where the game hangs a player's item), and the items built so far by recorded slot.
    private Transform? _socket;
    // Each weapon built, with the node its left hand grips (the item's own LeftHandGripTrans; null: none).
    private readonly Dictionary<int, (GameObject Item, Weapon? Gun, uint Id, Transform? Grip)> _items = new();
    // The game's own third-person IK on the rig, the PlayerSyncIK every remote player has, told what the game tells a remote player's: the item
    // the aim solver points (SetAimRef), the left hand's grip, the weights, and each frame the point the look and the aim go to. Its FinalIK
    // components stay on and solve in their own late update, after the animator posed the body, as on a remote player. Null when the rig has
    // none; _ik holds it and every component of it, which the body keeps.
    private PlayerSyncIK? _sync;
    private readonly HashSet<IntPtr> _ik = new();
    private readonly List<Component> _ikParts = new();
    private readonly HashSet<int> _asked = new();
    // The gear line each slot's weapon was asked for with: a slot whose line changes (a tool swapped in the level, another player in the seat) is built again.
    private readonly Dictionary<int, string> _lineOf = new();
    private int _wanted = -1;
    private readonly Quaternion _turn;
    // The body's root transform, read once when it is made: a GameObject keeps its transform for as long as it lives, and nothing here outlives the body (Held).
    private readonly Transform _place;
    private StandIn(GameObject body, Animator animator, Quaternion turn, Action<string, string> note) { _body = body; _place = body.transform; _animator = animator; _human = animator.isHuman; _turn = turn; _note = note; Changed(); }

    /// <summary>The model object, for outlining it and hanging things on it.</summary>
    internal GameObject Body => _body;

    /// <summary>The body's animator, for its bones.</summary>
    internal Animator Animator => _animator;

    internal bool Held => _body != null && !_body.WasCollected;

    /// <summary>Shows or hides the whole stand-in, with everything in its hands and its light: the only switch there is. Shown again, every layer is
    /// entered anew at the next <see cref="Play"/> (an animator that was off starts from its default states).</summary>
    internal bool Visible
    {
        get => _visible;
        set
        {
            if (value == _visible || !Held) return;
            _visible = value;
            _body.SetActive(value);
            if (value) Array.Clear(_layers);
        }
    }

    private bool _visible = true;

    /// <summary>Makes a body as the game makes a player's (<c>PlayerAgent.Setup</c>): an instance of the player rig <paramref name="player"/> builds
    /// its own from (<c>m_rigBaseForClothes</c>, or under the old rig the model of character 0 in <c>m_modelsForSync</c>), its scripts taken off
    /// but its third-person IK, which is set up as the game sets up a player's. Any player agent gives the same rig. Null, with the reason in
    /// <paramref name="why"/>, when it cannot be made. <paramref name="note"/> takes what the body could not show later (a short reason and a detail).
    /// It wears nothing until <see cref="Dress"/>.</summary>
    internal static StandIn? Make(PlayerAgent player, Action<string, string> note, out string why)
    {
        why = "";
        GameObject? hold = null;
        try
        {
            var rig = PlayerAgent.USE_NEW_PLAYER_RIG ? player.m_rigBaseForClothes : player.m_modelsForSync is { Length: > 0 } models ? models[0] : null;
            if (rig == null) { why = "the player has no rig to build a body from"; return null; }
            // Made under an inactive parent and stripped there, so no script of the game ever wakes on it.
            hold = new GameObject("StandInHold");
            hold.SetActive(false);
            var body = UnityEngine.Object.Instantiate(rig, hold.transform);
            body.name = "StandIn";
            var model = body.GetComponentInChildren<PlayerSyncModelData>(true);
            var socket = model != null ? model.ItemAlign : null;
            // The rig's third-person IK stays (KeepIK); every other script of the game goes.
            var sync = body.GetComponentInChildren<PlayerSyncIK>(true);
            var kept = new HashSet<IntPtr>();
            var parts = new List<Component>();
            if (sync != null)
            {
                kept.Add(sync.Pointer);
                foreach (var part in new Component?[] { sync.m_aimIK, sync.m_lookIK, sync.m_leftArmIK, sync.m_rightArmIK, sync.m_bipedIK, sync.m_grounderBipedIK, sync.m_grounderIK, sync.m_fullbodyBipedIK, sync.m_FPSSpineIK, sync.m_FPSLookAt })
                    if (part != null && kept.Add(part.Pointer)) parts.Add(part);
            }
            Strip(body, kept);
            var animator = body.GetComponentInChildren<Animator>(true);
            if (animator == null) { UnityEngine.Object.Destroy(hold); why = "the rig has no animator"; return null; }
            animator.applyRootMotion = false;
            animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            var made = new StandIn(body, animator, body.transform.localRotation, note) { _socket = socket };
            made._head = made._human ? animator.GetBoneTransform(HumanBodyBones.Head) : null;
            if (socket == null) note("a stand-in has no hand to hold a weapon in", rig.name);
            if (sync != null) made.KeepIK(sync, parts);
            body.transform.SetParent(null, false);
            UnityEngine.Object.Destroy(hold);
            body.SetActive(true);
            return made;
        }
        catch (Exception error)
        {
            // What was built so far goes: a half-made body would stand in the scene with no one holding it.
            if (hold != null && !hold.WasCollected) UnityEngine.Object.Destroy(hold);
            why = error.ToString();
            return null;
        }
    }

    // The rig's PlayerSyncIK, set up as the game sets up a player's (Setup, Enable) while the body is still inactive, so its FinalIK components
    // start on the body's bones when it wakes. One thing the game does not do: the aim solver points along the hand socket (else the head) until
    // the first item names the node it points (a solver with no node would not start); the first-person spine and look IK are off, as on every
    // remote body. A rig whose look, aim or left arm solver or look origin is missing keeps its animated pose.
    private void KeepIK(PlayerSyncIK sync, List<Component> parts)
    {
        var aim = sync.m_aimIK; var look = sync.m_lookIK; var left = sync.m_leftArmIK; var origin = sync.m_aimLookOriginTransform;
        if (aim == null || look == null || left == null || origin == null)
        {
            _note("a stand-in's body lacks some of the game's third-person IK; it stays as animated",
                (aim == null ? "aim " : "") + (look == null ? "look " : "") + (left == null ? "left arm " : "") + (origin == null ? "origin" : ""));
            Off(parts);
            return;
        }
        try
        {
            if (sync.m_FPSSpineIK != null) sync.m_FPSSpineIK.enabled = false;
            if (sync.m_FPSLookAt != null) sync.m_FPSLookAt.enabled = false;
            var node = aim.solver.transform;
            if (node == null || !node.IsChildOf(_place)) aim.solver.transform = _socket != null ? _socket : _head;
            sync.Setup(null);
            sync.Enable();
            sync.ZeroAllTargetWeights();
            _sync = sync;
            _ik.Add(sync.Pointer);
            foreach (var part in parts) { _ik.Add(part.Pointer); _ikParts.Add(part); }
        }
        catch (Exception error) { _note("a stand-in's third-person IK could not be set up; it stays as animated", error.Message); Off(parts); }
    }

    // Kept components no PlayerSyncIK drives would solve toward whatever they were last given.
    private static void Off(List<Component> parts)
    {
        foreach (var part in parts) if (part.TryCast<Behaviour>() is { } behaviour) behaviour.enabled = false;
    }

    private static void Strip(GameObject body, HashSet<IntPtr>? keep = null)
    {
        // Twice: a script another one requires goes only after that one.
        for (var pass = 0; pass < 2; pass++)
            foreach (var script in body.GetComponentsInChildren<MonoBehaviour>(true)) if (script != null && (keep == null || !keep.Contains(script.Pointer))) UnityEngine.Object.DestroyImmediate(script);
        // A player's physics and its own lights do not belong on a picture of the player (the stand-in makes its own flashlight); joints go
        // before the bodies they need.
        foreach (var joint in body.GetComponentsInChildren<Joint>(true)) if (joint != null) UnityEngine.Object.DestroyImmediate(joint);
        foreach (var rigid in body.GetComponentsInChildren<Rigidbody>(true)) if (rigid != null) UnityEngine.Object.DestroyImmediate(rigid);
        foreach (var collider in body.GetComponentsInChildren<Collider>(true)) if (collider != null) UnityEngine.Object.DestroyImmediate(collider);
        foreach (var light in body.GetComponentsInChildren<Light>(true)) if (light != null) light.enabled = false;
    }

    // The game's effect meshes on the rig's bones (FX_NanoSwarm_Looping_Head_01 and so on): not body, and nothing on the stand-in would ever switch them.
    private const string RigEffect = "FX_";

    // What the clothes RuntimeRigSwitch puts on need to draw with no script behind them: on a layer the main camera draws, skinned off screen
    // too (the animator always animates), a level-of-detail group at its best level. What hangs in the hand socket (a weapon, whose hidden
    // parts stay hidden) and a look's model are left alone.
    private void Keep()
    {
        // A corpse's decay component must never come with clothes (it would start a decay on a renderer that is not a corpse).
        foreach (var decay in _body.GetComponentsInChildren<Decay>(true)) if (decay != null) UnityEngine.Object.DestroyImmediate(decay);
        var main = Camera.main;
        var mask = main != null ? main.cullingMask : ~0;
        foreach (var renderer in _body.GetComponentsInChildren<Renderer>(true))
        {
            if (renderer == null || (_socket != null && renderer.transform.IsChildOf(_socket)) || ForgeVisual.PlayerLooks.Worn(renderer.transform)) continue;
            if (renderer.name.StartsWith(RigEffect, StringComparison.Ordinal)) { renderer.enabled = false; continue; }
            if ((mask & (1 << renderer.gameObject.layer)) == 0) renderer.gameObject.layer = 0;
            if (renderer.TryCast<SkinnedMeshRenderer>() is { } skin) skin.updateWhenOffscreen = true;
        }
        foreach (var group in _body.GetComponentsInChildren<LODGroup>(true)) if (group != null) group.ForceLOD(0);
    }

    // Every change of what the body draws takes the next number, across all stand-ins, so a new stand-in never repeats an old one's.
    private static int _versions;

    /// <summary>Changes whenever what the body draws changes (its clothes, its look, the item shown in its hands): whoever outlines it collects
    /// its renderers again then.</summary>
    internal int Version { get; private set; }

    private void Changed() => Version = ++_versions;

    private int _character = -1;
    private string? _outfit;
    private string? _lookLine;
    private ForgeVisual.PlayerLook? _lookToWear;
    private ForgeVisual.ILookDress? _dress;
    private long _lookNextMs;
    // A look the provider is still loading is asked for again this often.
    private const long LookRetryMs = 1000;

    /// <summary>How the recorded player looks, applied in one order every time: the clothes of character <paramref name="character"/> (0 Woods,
    /// 1 Dauda, 2 Hackett, 3 Bishop) in the outfit line <paramref name="outfit"/> (vanity item IDs of the helmet, torso, legs, backpack and
    /// palette; "" or 0 for the character's default) put on the way the game dresses every player (<see cref="PutOn"/>), then the look line
    /// <paramref name="look"/> (ForgeCore's look provider id and its description in base64, space separated; "" for none) worn through ForgeCore's
    /// player looks, which hangs the provider's model on the body and hides the body's person, then the look's skins on what it holds. Told every
    /// frame; a changed outfit takes the look off, dresses again and wears the look again, a changed look swaps only the look. A look the provider
    /// is still loading is asked for again every second; one no provider installed here can wear leaves the body in its recorded outfit, silently.</summary>
    internal void Dress(int character, string outfit, string look)
    {
        if (!Held) return;
        if (character != _character || outfit != _outfit)
        {
            TakeOff();
            _character = character; _outfit = outfit;
            PutOn(character, outfit);
            _lookNextMs = 0;
            Changed();
        }
        if (look != _lookLine)
        {
            TakeOff();
            _lookLine = look;
            _lookToWear = Read(look);
            _lookNextMs = 0;
        }
        if (_dress != null || _lookToWear == null) return;
        var now = Environment.TickCount64;
        if (now < _lookNextMs) return;
        _lookNextMs = now + LookRetryMs;
        Wear(_lookToWear.Value);
    }

    private static ForgeVisual.PlayerLook? Read(string line)
    {
        var space = line.LastIndexOf(' ');
        if (space <= 0) return null;
        try { return new ForgeVisual.PlayerLook(line.Substring(0, space), Convert.FromBase64String(line.Substring(space + 1))); }
        catch (FormatException) { return null; }
    }

    private void Wear(ForgeVisual.PlayerLook look)
    {
        _dress = ForgeVisual.PlayerLooks.Dress(look, _animator);
        if (_dress == null) return;
        foreach (var shown in _items.Values) if (shown.Item != null && !shown.Item.WasCollected) DressItem(shown.Item.GetComponent<ItemEquippable>());
        Changed();
    }

    // The look comes off and the body is the game's again (the provider shows the person it hid and takes its model away).
    private void TakeOff()
    {
        if (_dress == null) return;
        try { _dress.Release(); }
        catch (Exception error) { _note("a stand-in's look could not be taken off", error.Message); }
        _dress = null;
        Changed();
    }

    /// <summary>For the probe: the outfit and look worn, how many meshes draw, the largest by its bounds (a mesh skinned wrong spans metres), and
    /// where the weapon, its left-hand grip and the two hands are.</summary>
    internal string Describe()
    {
        var text = new System.Text.StringBuilder("outfit [").Append(_outfit ?? "-").Append("] look ").Append(_dress != null ? "worn" : _lookToWear != null ? "waiting" : "none");
        var drawn = 0; var largest = 0f; var name = "";
        foreach (var renderer in _body.GetComponentsInChildren<Renderer>(false))
        {
            if (renderer == null || !renderer.enabled || renderer.forceRenderingOff) continue;
            drawn++;
            var size = renderer.bounds.size.magnitude;
            if (size > largest) { largest = size; name = renderer.name; }
        }
        text.Append(" meshes ").Append(drawn).Append(" largest ").Append(name).Append(' ').Append(largest.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture)).Append(" m");
        if (_items.TryGetValue(_wanted, out var shown) && shown.Item != null)
        {
            text.Append(" weapon ").Append(shown.Item.transform.position);
            if (shown.Grip != null) text.Append(" grip ").Append(shown.Grip.position);
        }
        if (_sync != null)
        {
            var aimNode = _sync.m_aimIK.solver.transform;
            text.Append(" aims along ").Append(aimNode != null ? aimNode.name : "-").Append(" ik weights aim ").Append(Two(_sync.m_aimWeight))
                .Append(" look ").Append(Two(_sync.m_lookWeight)).Append(" left ").Append(Two(_sync.m_leftArmWeight))
                .Append(" left rotation ").Append(Two(_sync.m_leftArmIK.solver.IKRotationWeight)).Append(" solving ").Append(_sync.m_aimIK.enabled);
        }
        else text.Append(" ik none");
        if (_human)
        {
            var right = _animator.GetBoneTransform(HumanBodyBones.RightHand); var left = _animator.GetBoneTransform(HumanBodyBones.LeftHand);
            if (right != null) text.Append(" right hand ").Append(right.position);
            if (left != null) text.Append(" left hand ").Append(left.position);
        }
        return text.ToString();
    }

    private static string Two(float value) => value.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture);

    // As PlayerBackpackManager.EquipVanityItemsFromBackpack dresses a player's rig: the rig's clothes go and the game's rig switch
    // (RuntimeRigSwitch) puts on the character's face and each item (DefaultCharacterLayouts gives the defaults; an item this install does not
    // have is the default, without a note).
    private void PutOn(int character, string outfit)
    {
        try
        {
            var layout = DefaultCharacterLayouts.GetDefaultVanityItems(character & 3);
            Undress();
            var rig = new RuntimeRigSwitch(_body);
            if (layout.Face != null) rig.Equip(ClothesType.Face, layout.Face);
            var ids = outfit.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            for (var i = 0; i < OutfitTypes.Length; i++)
            {
                var id = i < ids.Length && uint.TryParse(ids[i], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var read) ? read : 0u;
                if (id == 0 || !GameData.VanityItemsTemplateDataBlock.HasBlock(id)) id = layout.GetItemId(OutfitTypes[i]);
                if (id != 0 && GameData.VanityItemsTemplateDataBlock.HasBlock(id)) rig.Equip(GameData.VanityItemsTemplateDataBlock.GetBlock(id));
            }
            // What the items brought along runs no script of the game; the body's IK stays.
            foreach (var script in _body.GetComponentsInChildren<MonoBehaviour>(true))
                if (script != null && (_socket == null || !script.transform.IsChildOf(_socket)) && !_ik.Contains(script.Pointer)) UnityEngine.Object.DestroyImmediate(script);
            Keep();
        }
        catch (Exception error) { _note("a stand-in could not put on its outfit", error.Message); }
    }

    // The order of the outfit line; the palette last, so it colours the items put on before it.
    private static readonly ClothesType[] OutfitTypes = { ClothesType.Helmet, ClothesType.Torso, ClothesType.Legs, ClothesType.Backpack, ClothesType.Palette };

    // Every mesh of the rig goes (the clothes, the face): nothing of the game's player is a bare body, all of it is clothes. At once, so the rig
    // switch made next finds no bone of them. What hangs in the hand socket, a look's model and the nodes the skeleton, the socket and the IK hang
    // on stay (only such a node's mesh goes).
    private void Undress()
    {
        foreach (var renderer in _body.GetComponentsInChildren<Renderer>(true))
        {
            if (renderer == null) continue; // destroyed already with the object of a mesh before it
            var place = renderer.transform;
            if ((_socket != null && place.IsChildOf(_socket)) || ForgeVisual.PlayerLooks.Worn(place)) continue;
            if (_animator.transform.IsChildOf(place) || (_socket != null && _socket.IsChildOf(place)) || HoldsIK(place)) UnityEngine.Object.DestroyImmediate(renderer);
            else UnityEngine.Object.DestroyImmediate(renderer.gameObject);
        }
    }

    private bool HoldsIK(Transform place)
    {
        if (_sync != null && _sync.transform.IsChildOf(place)) return true;
        foreach (var part in _ikParts) if (part.transform.IsChildOf(place)) return true;
        return false;
    }

    // The look's weapon skin on an item the body holds.
    private void DressItem(ItemEquippable? item)
    {
        if (_dress == null || item == null) return;
        try { _dress.Hold(item); }
        catch (Exception error) { _note("a stand-in's look could not dress its weapon", error.Message); }
    }

    /// <summary>The hand the things it holds hang in; null when the body has none.</summary>
    internal Transform? Hand => _socket;

    /// <summary>Something else is in the hands (a pack, a carried item its holder shows there): the weapon is put away for as long.</summary>
    internal bool Covered
    {
        get => _covered;
        set
        {
            if (value == _covered) return;
            _covered = value;
            foreach (var (key, shown) in _items) if (shown.Item != null && !shown.Item.WasCollected) shown.Item.SetActive(!value && key == _wanted);
            Grip();
            Changed();
        }
    }

    private bool _covered;

    /// <summary>The line <see cref="Hold"/> takes for an item that is not gear (a pack, a consumable, a carried item): its item id.</summary>
    internal static string ItemLine(uint itemId) => ItemLinePrefix + itemId.ToString(System.Globalization.CultureInfo.InvariantCulture);

    private const string ItemLinePrefix = "item ";

    /// <summary>Shows what the player holds in inventory slot <paramref name="slot"/> in the hands: gear line <paramref name="gearLine"/> built
    /// once through the game's own third-person assembly, or an item (<see cref="ItemLine"/>) spawned once through the game's own item spawn in
    /// its third-person mode, as the game makes another player's held item (every handler of that spawn dresses it as in play). Kept; the
    /// one shown before goes away. Asked again each frame while gear assets load.</summary>
    internal void Hold(int slot, string gearLine)
    {
        if (!Held || _socket == null) return;
        if (_lineOf.TryGetValue(slot, out var before) && before != gearLine)
        {
            if (_items.Remove(slot, out var old) && old.Item != null && !old.Item.WasCollected) UnityEngine.Object.Destroy(old.Item);
            _asked.Remove(slot); _lineOf.Remove(slot);
            if (slot == _wanted) Grip();
            Changed();
        }
        if (slot != _wanted)
        {
            _wanted = slot;
            foreach (var (key, shown) in _items) shown.Item.SetActive(!_covered && key == slot);
            Grip();
            Changed();
        }
        if (_items.ContainsKey(slot) || _asked.Contains(slot) || gearLine.Length == 0) return;
        if (gearLine.StartsWith(ItemLinePrefix, StringComparison.Ordinal))
        {
            _asked.Add(slot); _lineOf[slot] = gearLine;
            SpawnItem(slot, gearLine);
            return;
        }
        var gear = new GearIDRange(gearLine);
        var reading = ForgeCore.Gear.Prepare(gear);
        if (reading.Status == GearAssetStatus.Loading) return;
        _asked.Add(slot); _lineOf[slot] = gearLine;
        if (reading.Status == GearAssetStatus.Failed) { _note("a stand-in could not take its gear", reading.Detail); return; }
        GearManager.AssembleGearAsync(gear, ItemMode.ThirdPerson, new Action<ItemEquippable>(item => Made(slot, gearLine, item)));
    }

    // The game's own item spawn (ItemSpawnManager.SpawnItem, the entry another peer's third-person item comes from), set up, under the hand.
    private void SpawnItem(int slot, string line)
    {
        var id = uint.Parse(line.AsSpan(ItemLinePrefix.Length), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture);
        if (!ItemSpawnManager.ItemHasMode(id, ItemMode.ThirdPerson)) { _note("an item in a player's hands has no third-person look", "item " + id); return; }
        var block = GameData.ItemDataBlock.GetBlock(id);
        var data = new pItemData { itemID_gearCRC = id, slot = block != null ? block.inventorySlot : InventorySlot.None };
        var spawned = ItemSpawnManager.SpawnItem(id, ItemMode.ThirdPerson, _socket!.position, _socket.rotation, true, data, _socket);
        var item = spawned != null ? spawned.TryCast<ItemEquippable>() : null;
        if (item == null)
        {
            if (spawned != null) UnityEngine.Object.Destroy(spawned.gameObject);
            _note("an item in a player's hands could not be made", "item " + id);
            return;
        }
        Made(slot, line, item);
    }

    private void Made(int slot, string gearLine, ItemEquippable item)
    {
        try
        {
            if (item == null) return;
            if (!Held) { UnityEngine.Object.Destroy(item.gameObject); return; }
            // The line changed while it was built: this one is old, and goes.
            if (!_lineOf.TryGetValue(slot, out var current) || current != gearLine) { UnityEngine.Object.Destroy(item.gameObject); return; }
            var root = item.gameObject;
            // Only what draws stays awake: no script of the item runs without an owner.
            // The muzzle flash's own script stays on: its Update is what ends a flash after its life time, and a flash played with that script
            // off never went out (the gun's flash stayed lit the whole replay).
            foreach (var script in root.GetComponentsInChildren<MonoBehaviour>(true))
                if (script != null && script.TryCast<EX_SpriteMuzzleFlash>() == null) script.enabled = false;
            item.TryCast<Weapon>()?.m_muzzleFlash?.Stop();
            foreach (var collider in root.GetComponentsInChildren<Collider>(true)) if (collider != null) collider.enabled = false;
            // In the hand as PlayerInventorySynced.DoEquipItem puts it on a remote player: hung in the socket, then moved by the item's own
            // CalcRightHandGripOffset so its right-hand grip sits in the socket.
            root.transform.SetParent(_socket, false);
            root.transform.localPosition = Vec.Zero;
            root.transform.localRotation = Quaternion.identity;
            root.transform.localScale = Vector3.one;
            item.CalcRightHandGripOffset(_socket);
            root.SetActive(!_covered && slot == _wanted);
            _items[slot] = (root, item.TryCast<Weapon>(), item.ItemDataBlock?.persistentID ?? 0, item.LeftHandGripTrans);
            if (slot == _wanted) Grip();
            DressItem(item);
            Changed();
        }
        catch (Exception error) { _note("a stand-in's weapon could not be put in its hands", error.Message); }
    }

    // The game's flashlight, read from a running player (PlayerInventoryBase.m_flashlight): a spot light with these values. It hangs under the body's head along the look direction.
    private const float LampRange = 11f, LampAngle = 40f, LampIntensity = 0.35f, LampForward = 0.2f;
    private static readonly Color LampColour = new(1f, 0.963f, 0.731f, 1f);
    private Light? _lamp;
    private Transform? _lampAt;
    private bool _lampOn;
    private Transform? _head;
    private Vector3 _look = Vector3.forward;

    /// <summary>The player's flashlight on or off: the body has no player inventory to switch, so it carries a spot light of the game's own flashlight values.</summary>
    internal void Lamp(bool on)
    {
        if (!Held) return;
        if (_lamp == null)
        {
            if (!on) return;
            _head = _animator.isHuman ? _animator.GetBoneTransform(HumanBodyBones.Head) : null;
            var holder = new GameObject("StandInLamp");
            holder.transform.SetParent(_body.transform, false);
            _lampAt = holder.transform;
            _lamp = holder.AddComponent<Light>();
            _lamp.type = LightType.Spot; _lamp.range = LampRange; _lamp.spotAngle = LampAngle; _lamp.intensity = LampIntensity; _lamp.color = LampColour; _lamp.shadows = LightShadows.None;
        }
        _lamp.enabled = _lampOn = on;
    }

    // Every frame: the light follows the head (with none, the point 1.6 m over the body), kept in plain fields so only the head's position is read.
    private void PlaceLamp(Vector3 body)
    {
        var sqr = Vec.SqrLength(_look);
        if (_lampAt == null || !_lampOn || sqr < 1e-6f) return;
        var at = (_head != null ? _head.position : new Vector3(body.x, body.y + 1.6f, body.z)) + _look * (LampForward / Mathf.Sqrt(sqr));
        _lampAt.SetPositionAndRotation(at, Quaternion.LookRotation(_look));
    }

    // The sound engine's character switches by recorded slot: the game gives each player slot its own character voice.
    private static readonly uint[] Characters = { AK.SWITCHES.CHARACTER.SWITCH.CH_01, AK.SWITCHES.CHARACTER.SWITCH.CH_02, AK.SWITCHES.CHARACTER.SWITCH.CH_03, AK.SWITCHES.CHARACTER.SWITCH.CH_04 };

    /// <summary>The player says one of the game's voice lines (Wwise event <paramref name="eventId"/>) at the body's head, as the character of recorded slot
    /// <paramref name="slot"/>: the body has no <c>PlayerVoice</c> to say it through, so the line is posted at its place with that character's switch.</summary>
    internal void Say(int slot, uint eventId)
    {
        if (!Held) return;
        var at = _head != null ? _head.position : _place.position + Vec.Up * 1.6f;
        AudioKit.PostGameEvent(eventId, at, AK.SWITCHES.CHARACTER.GROUP, Characters[slot & 3]);
    }

    /// <summary>Layer <paramref name="layer"/> of the body controller plays <paramref name="state"/> (the game's state hash), begun at
    /// <paramref name="startMs"/> on the holder's clock, which stands at <paramref name="nowMs"/>, at <paramref name="weight"/> (0 to 1). Told every
    /// frame: a state or a start that differs from the last one told is entered, cross-faded over <paramref name="fadeSeconds"/> when it has just begun
    /// and at once, at the time it has reached, when <paramref name="jumped"/> (a jump in time) or it is already under way. <paramref name="seconds"/>
    /// is the frame's real time, for the weight's ease and the check that the layer still plays what it was told.</summary>
    internal void Play(int layer, int state, long startMs, long nowMs, float fadeSeconds, float weight, bool jumped, float seconds)
    {
        if (!Held || !_visible || (uint)layer >= Layers) return;
        ref var at = ref _layers[layer];
        at.Weight = jumped || !at.Told ? weight : Mathf.MoveTowards(at.Weight, weight, WeightRate * seconds);
        _animator.SetLayerWeight(layer, at.Weight);
        var into = Mathf.Max(0f, (nowMs - startMs) / 1000f);
        if (!at.Told || jumped || at.State != state || Math.Abs(at.StartMs - startMs) > RestartMs)
        {
            var fade = jumped || !at.Told || into > fadeSeconds ? 0f : fadeSeconds;
            at = new Layer { State = state, StartMs = startMs, Weight = at.Weight, Told = true };
            _animator.CrossFadeInFixedTime(state, fade, layer, into);
            _moved = true;
            return;
        }
        if (at.GaveUp || seconds <= 0f) return;
        if (_animator.GetCurrentAnimatorStateInfo(layer).shortNameHash == state || _animator.IsInTransition(layer) && _animator.GetNextAnimatorStateInfo(layer).shortNameHash == state) { at.Wrong = 0f; return; }
        at.Wrong += seconds;
        if (at.Wrong < WrongSeconds) return;
        at.Wrong = 0f;
        if (at.Retried)
        {
            at.GaveUp = true;
            if (_gaveUpOn.Add((layer, state))) _note("a stand-in's layer does not stay in the state it is told", "layer " + layer + ", state " + state);
            return;
        }
        at.Retried = true;
        _animator.CrossFadeInFixedTime(state, 0f, layer, into);
        _moved = true;
    }

    // A start this far from the one told is the state begun again, not the same start read a frame apart.
    private const long RestartMs = 100;

    /// <summary>The name of the item shown in the hands now, "" when none (for the probe).</summary>
    internal string HeldName => _items.TryGetValue(_wanted, out var shown) && shown.Item != null ? shown.Item.name : "";

    /// <summary>The data block ID of the item the game assembled for the weapon shown, 0 when none (for the probe).</summary>
    internal uint HeldId => _items.TryGetValue(_wanted, out var shown) ? shown.Id : 0;

    /// <summary>The recorded slot whose weapon is shown, -1 when none.</summary>
    internal int HeldSlot => _wanted;

    /// <summary>Plays the muzzle flash of the weapon in the hands (no shot, no sound); false when it has none.</summary>
    internal bool MuzzleFlash(out Vector3 muzzle)
    {
        muzzle = _body != null ? _place.position : Vec.Zero;
        if (!_items.TryGetValue(_wanted, out var shown) || shown.Gun == null || shown.Gun.WasCollected || shown.Gun.m_muzzleFlash == null) return false;
        try
        {
            shown.Gun.m_muzzleFlash.Play();
            if (shown.Gun.MuzzleAlign != null) muzzle = shown.Gun.MuzzleAlign.position;
            return true;
        }
        catch (Exception error) { _note("a stand-in's muzzle flash could not play", error.Message); return false; }
    }

    /// <summary>Puts the body at <paramref name="position"/> turned along <paramref name="look"/> and gives its animator the game's body parameters:
    /// the walk values <paramref name="forward"/> and <paramref name="right"/>, <paramref name="crouch"/> (0 standing to 1 crouched) and the aim
    /// pitch <paramref name="aim"/>, each eased as the game eases them. <paramref name="rate"/> is the animator's speed (0 holds every state where
    /// it is); <paramref name="seconds"/> the frame's real time. Called once a frame, after the frame's <see cref="Play"/> calls: a state entered
    /// while the animator stands still is shown at once.</summary>
    internal void Pose(Vector3 position, Vector3 look, float forward, float right, float crouch, float aim, float rate, float seconds, bool jumped)
    {
        if (!Held || !_visible) return;
        _look = look;
        var flat = new Vector3(look.x, 0f, look.z);
        if (Vec.SqrLength(flat) > 1e-6f) _yaw = Quaternion.LookRotation(flat);
        _place.SetPositionAndRotation(position, _yaw * _turn);
        _forward = jumped ? forward : Mathf.MoveTowards(_forward, forward, WalkRate * seconds);
        _right = jumped ? right : Mathf.MoveTowards(_right, right, WalkRate * seconds);
        _crouchValue = jumped ? crouch : Mathf.MoveTowards(_crouchValue, crouch, CrouchRate * seconds);
        _aim = jumped ? aim : Mathf.MoveTowards(_aim, aim, CrouchRate * seconds);
        _animator.SetFloat(Forward, _forward);
        _animator.SetFloat(Right, _right);
        _animator.SetFloat(Crouch, _crouchValue);
        _animator.SetFloat(AimPitch, _aim);
        _animator.speed = rate;
        // Standing still, the animator evaluates nothing by itself: the states just entered and the parameters are taken in by one update of no time.
        if (rate == 0f && (_moved || jumped)) { _animator.speed = 1f; _animator.Update(0f); _animator.speed = 0f; }
        _moved = false;
        Aim(seconds);
        PlaceLamp(position);
    }

    // Each frame, what PlayerLocomotion.SyncIKAimUpdate does for a remote player: the look and the aim go to the point AimMetres along the look
    // from the IK's own look origin, and UpdateIK eases the weights. The components solve later in the frame, after the animator.
    private void Aim(float seconds)
    {
        var sqr = Vec.SqrLength(_look);
        if (_sync == null || sqr < 1e-6f) return;
        try
        {
            var target = _sync.GetAimLookOrigin() + _look * (AimMetres / Mathf.Sqrt(sqr));
            _sync.SetAimTarget(target);
            _sync.SetLookTarget(target);
            _sync.UpdateIK(seconds);
        }
        catch (Exception error) { _note("a stand-in's third-person IK failed; it stays as animated", error.Message); StopIK(); }
    }

    // The distance PlayerLocomotion.SyncIKAimUpdate puts the look and aim point at.
    private const float AimMetres = 10f;

    // What the hands hold changed: as ItemEquippable.UpdateSyncIKGrips does on a remote player, the aim solver points the item, the left hand
    // goes to its grip (none: no left arm IK) and the weights go to full; with nothing shown, the aim and the left arm go back to the animation
    // (PlayerSyncIK.ZeroAllTargetWeights, as the game does while the hands are busy) and the look stays.
    private void Grip()
    {
        if (_sync == null) return;
        try
        {
            if (_covered || !_items.TryGetValue(_wanted, out var shown) || shown.Item == null || shown.Item.WasCollected) { _sync.ZeroAllTargetWeights(); return; }
            _sync.SetAimRef(shown.Item.transform);
            _sync.SetLeftArmTarget(shown.Grip);
            _sync.SetAllWeights(1f, 1f, shown.Grip != null ? 1f : 0f);
        }
        catch (Exception error) { _note("a stand-in's third-person IK failed; it stays as animated", error.Message); StopIK(); }
    }

    private void StopIK()
    {
        _sync = null;
        foreach (var part in _ikParts) if (part != null && !part.WasCollected && part.TryCast<Behaviour>() is { } behaviour) behaviour.enabled = false;
    }

    private readonly bool _human;

    public void Dispose()
    {
        TakeOff();
        if (Held) UnityEngine.Object.Destroy(_body); // its weapons and the look's model hang under it and go with it
    }
}
