using System;
using System.Collections.Generic;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
using UnityEngine;
using Object = UnityEngine.Object;

namespace ForgeVisual;

/// <summary>The outcome of <see cref="ImportedModels.Create"/>: the model, or why there is none (a failure is also logged, once).</summary>
public sealed class ImportedModelResult
{
    internal ImportedModelResult(ImportedModel? model, ImportedModelFailure failure)
    {
        Model = model;
        Failure = failure;
    }

    public ImportedModel? Model { get; }
    public ImportedModelFailure Failure { get; }
    public bool Ok => Model != null;
}

/// <summary>A built imported model: one Unity mesh with a submesh per run of its descriptor and one lit material per submesh. Every
/// instance made by <see cref="Spawn"/> shares them. The cache that made it owns it; do not destroy its parts.</summary>
public sealed class ImportedModel
{
    private readonly Mesh _mesh;
    private readonly Material[] _slots;
    private readonly Matrix4x4[]? _rest;
    private readonly List<GameObject> _spawned = new();
    // 表情的稀疏位移（格式 3）与它们已经加到网格上的混合形状下标（-1：还没加）。
    private readonly ImportedMesh.ImportedMorph[]? _deltas;
    private readonly int[] _shape;
    private readonly int _vertices;
    private int _shapes;

    internal ImportedModel(ImportedModelDescriptor descriptor, Mesh mesh, Material[] slots, List<Object> owned, Matrix4x4[]? rest, ImportedMesh.ImportedMorph[]? deltas, int vertices)
    {
        Descriptor = descriptor;
        _mesh = mesh;
        _slots = slots;
        _rest = rest;
        Owned = owned;
        _deltas = deltas;
        _vertices = vertices;
        _shape = new int[descriptor.Morphs?.Count ?? 0];
        for (var i = 0; i < _shape.Length; i++) _shape[i] = -1;
    }

    /// <summary>Whether the model is skinned to its own skeleton (descriptor format 2): <see cref="Spawn"/> then builds the bones too.</summary>
    public bool Skinned => _rest != null;

    public ImportedModelDescriptor Descriptor { get; }

    /// <summary>The mesh, for bounds and counts. Shared and no longer readable.</summary>
    public Mesh Mesh => _mesh;

    /// <summary>The materials in submesh order; shared by every instance. <c>Glow</c> and tints are written on copies.</summary>
    public IReadOnlyList<Material> Materials => _slots;

    /// <summary>The model's expressions (format 3) in the mesh's order; empty when it has none.</summary>
    public IReadOnlyList<string> Morphs => Descriptor.Morphs ?? (IReadOnlyList<string>)Array.Empty<string>();

    /// <summary>The index of the expression called <paramref name="name"/>; -1 when the model has none by that name.</summary>
    public int MorphIndex(string name)
    {
        var morphs = Descriptor.Morphs;
        if (morphs == null || name == null) return -1;
        for (var i = 0; i < morphs.Count; i++) if (string.Equals(morphs[i], name, StringComparison.Ordinal)) return i;
        return -1;
    }

    /// <summary>The mesh's blend shape index for expression <paramref name="index"/>, adding the shape the first time. Unity stores a shape
/// per expression <em>and per vertex</em>, and an MMD model carries dozens of expressions on a hundred thousand vertices: only the ones
/// a caller actually uses are added. -1 when the model has no such expression (or the mesh refused the shape).</summary>
    public int EnsureMorph(int index)
    {
        if (index < 0 || index >= _shape.Length || _deltas == null || _deltas.Length <= index) return -1;
        if (_shape[index] >= 0) return _shape[index];
        var morph = _deltas[index];
        var frame = new Vector3[_vertices];
        for (var i = 0; i < morph.Vertices.Length; i++)
        {
            var vertex = morph.Vertices[i];
            if (vertex < 0 || vertex >= _vertices) continue;
            frame[vertex] = new Vector3(morph.Deltas[i * 3], morph.Deltas[i * 3 + 1], morph.Deltas[i * 3 + 2]);
        }
        try { _mesh.AddBlendShapeFrame(Descriptor.Morphs![index], 100f, frame, null, null); }
        catch (Exception) { return -1; }
        return _shape[index] = _shapes++;
    }

    /// <summary>Sets one expression's weight (0 to 100) on an instance <see cref="Spawn"/> made; false when the instance or the expression
    /// is not there. The first call for an expression adds its blend shape to the shared mesh.</summary>
    /// <remarks>混合形状的权重是每个渲染器各存一份，而一个实例身上常挂着不止一个画这份网格的渲染器（卡通描边的覆盖层、人物替身的
    /// <c>ForgeVisual.LookGhost</c> 双胞胎）：只写 Spawn 那一个的话，盖在上面的那一份永远是没表情的原始网格，游戏里就看不到表情。
    /// 另外 Unity 在网格挂上渲染器的那一刻读它的表情，之后再 <c>AddBlendShapeFrame</c> 的形状要把同一份网格重新挂一次才生效。</remarks>
    public bool SetMorph(GameObject instance, int index, float weight)
    {
        if (instance == null || instance.WasCollected) return false;
        var shape = EnsureMorph(index);
        if (shape < 0) return false;
        var w = Mathf.Clamp(weight, 0f, 100f);
        var drawn = Drawn(instance);
        // 重挂状态按渲染器记，不按实例：形状是后来才加进共享网格的，每个渲染器都得在那一刻重新挂一次，Unity 才会按新的表情数
        // 重建它自己的那张权重表。按实例记时，只要有一次是在 0 个渲染器上算的（ForgeSkin 换身体网格那一瞬、替身还没挂上）就把
        // 整个实例标成"已同步"，之后新出现的渲染器永远等不到重挂——权重写进 size=0 的数组，Unity 每帧刷
        // "Array index (N) is out of bounds (size=0)"，画面上就是一张有表情的脸盖着一张没表情的脸（双层眼皮）。
        for (var i = 0; i < drawn.Count; i++)
        {
            var skin = drawn[i];
            if (skin == null || skin.WasCollected) continue;
            var mesh = skin.sharedMesh;
            if (mesh == null || mesh.blendShapeCount <= shape) continue;
            // 缓存可能已经过时（渲染器换了网格）：认错了就丢掉缓存，让下一次重新读。
            if (mesh.Pointer != _mesh.Pointer) { if (_drawn.ContainsKey(instance.GetInstanceID())) _drawn.Remove(instance.GetInstanceID()); continue; }
            var skinId = skin.GetInstanceID();
            var mounted = false;
            if (!_synced.TryGetValue(skinId, out var seen) || seen < _shapes)
            {
                // 把同一个引用赋回去 Unity 当作没换，权重表不会重建（日志里写完回读仍是 0）。先清空再挂回，渲染器才会按当前的表情数量重读一遍。
                skin.sharedMesh = null;
                skin.sharedMesh = mesh;
                _synced[skinId] = _shapes;
                mounted = true;
            }
            skin.SetBlendShapeWeight(shape, w);
            // 重挂之后应当一次就写进去；回读不上说明这个渲染器还有别的原因没拿到权重（留在日志里好定位，正常不会出现）。
            if (mounted && Mathf.Abs(skin.GetBlendShapeWeight(shape) - w) > 0.01f)
                Plugin.Logger.ErrorOnce("visual-morph-not-taken-" + skin.name, "ForgeVisual: '" + skin.name + "' still does not take expression " + shape + " after mounting the mesh again (mesh has " + mesh.blendShapeCount + " shapes, " + _shapes + " asked for); that face stays plain.");
        }
        return true;
    }

    // 每个实例下所有画着本模型网格的渲染器（Spawn 的那个在最前）；子物体数变了就重读（覆盖层/替身是后来才挂上去的），
    // 另外至少每秒重读一次：替身是在"刚挂到父物体下、还没有渲染器"的那一瞬把子物体数改掉的，只认子物体数会漏掉它。
    private readonly Dictionary<int, (int Children, List<SkinnedMeshRenderer> Skins, float At)> _drawn = new();

    // 每个渲染器（自身实例号）上次重挂网格时网格里已有几个表情（见 SetMorph）。
    private readonly Dictionary<int, int> _synced = new();

    // Drawn() 重读时用来挑出已经不在列表里的渲染器，只为少分配一次。
    private readonly List<int> _stale = new();

    private List<SkinnedMeshRenderer> Drawn(GameObject instance)
    {
        var id = instance.GetInstanceID();
        var children = instance.transform.childCount;
        if (_drawn.TryGetValue(id, out var got) && got.Skins != null && got.Children == children && Time.unscaledTime - got.At < 1f) return got.Skins;
        var skins = new List<SkinnedMeshRenderer>();
        foreach (var skin in instance.GetComponentsInChildren<SkinnedMeshRenderer>(true))
        {
            if (skin == null || skin.WasCollected || skin.sharedMesh == null) continue;
            if (skin.sharedMesh.Pointer != _mesh.Pointer) continue;
            if (skin.gameObject == instance) skins.Insert(0, skin);
            else skins.Add(skin);
        }
        // 空列表不进缓存：ForgeSkin 换身体模型时会先把渲染器挂到别的网格上再换回来，这一刻读到的是 0 个，缓存住就再也认不到了。
        if (skins.Count > 0)
        {
            _drawn[id] = (children, skins, Time.unscaledTime);
            // 新读到的渲染器不在 _synced 里，第一次写自然就重挂；把已经不在列表里的丢掉，免得渲染器销毁后实例号被复用、
            // 新的那个一上来就被当成"已同步"而漏掉重挂。
            _stale.Clear();
            foreach (var key in _synced.Keys)
            {
                var live = false;
                foreach (var skin in skins) if (skin.GetInstanceID() == key) { live = true; break; }
                if (!live) _stale.Add(key);
            }
            foreach (var key in _stale) _synced.Remove(key);
        }
        return skins;
    }

    internal List<Object> Owned { get; }

    /// <summary>A new object (under <paramref name="parent"/> when given) that draws the model, no collider: a mesh filter and a mesh renderer,
    /// or for a skinned model a skinned mesh renderer on the object and its skeleton below it, each bone a child object named as in the
    /// descriptor and standing at its rest pose (so the model stands as it was built; a caller poses the bones from there).</summary>
    public GameObject Spawn(Transform? parent = null, string? name = null)
    {
        var o = new GameObject(name ?? "Imported " + Descriptor.MeshSha256[..8]);
        if (parent != null) o.transform.SetParent(parent, false);
        if (_rest == null)
        {
            o.AddComponent<MeshFilter>().sharedMesh = _mesh;
            o.AddComponent<MeshRenderer>().sharedMaterials = new Il2CppReferenceArray<Material>(_slots);
        }
        else
        {
            var specs = Descriptor.Bones!;
            var bones = new Transform[specs.Count];
            for (var i = 0; i < bones.Length; i++)
            {
                var bone = new GameObject(specs[i].Name).transform;
                var up = specs[i].Parent;
                bone.SetParent(up < 0 ? o.transform : bones[up], false);
                var local = up < 0 ? _rest[i] : _rest[up].inverse * _rest[i];
                bone.localPosition = local.GetColumn(3);
                bone.localRotation = local.rotation;
                bone.localScale = local.lossyScale;
                bones[i] = bone;
            }
            var skin = o.AddComponent<SkinnedMeshRenderer>();
            skin.sharedMesh = _mesh;
            skin.bones = new Il2CppReferenceArray<Transform>(bones);
            skin.rootBone = bones[0];
            skin.sharedMaterials = new Il2CppReferenceArray<Material>(_slots);
        }
        _spawned.RemoveAll(s => s == null || s.WasCollected);
        _spawned.Add(o);
        // 带表情的模型登记起来：别的插件（舞蹈）按名字驱动表情，自动眨眼也开始在这个实例上工作。
        if (_deltas != null) ImportedModelApi.Bind(o, this);
        return o;
    }

    internal void DestroySpawned()
    {
        _drawn.Clear();
        _synced.Clear();
        foreach (var s in _spawned)
            if (s != null && !s.WasCollected)
            {
                ImportedModelApi.Unbind(s);
                Object.Destroy(s);
            }
        _spawned.Clear();
    }
}

/// <summary>导入模型自带的眨眼：每隔几秒把 まばたき 一类的表情压一下再放开，静止站着也有生命感。
/// 外部（舞蹈的表情曲线）自己驱动眼睛时用 <see cref="ImportedModelApi.SetBlink"/> 关掉，由 VisualFrame 每帧推进。</summary>
internal static class Blink
{
    private sealed class Entry
    {
        public GameObject Instance = null!;
        public ImportedModel Model = null!;
        public int Morph;
        public float Next;
        public float Start = -1f;
        public bool Off;
    }

    private static readonly List<Entry> _entries = new();
    private static readonly System.Random _random = new();
    private static readonly string[] _names = { "まばたき", "まばたき2", "まばたき２", "瞬き", "眨眼", "blink", "Blink", "目ぱち" };

    internal static void Add(GameObject instance, ImportedModel model)
    {
        var morph = -1;
        foreach (var name in _names) { morph = model.MorphIndex(name); if (morph >= 0) break; }
        if (morph < 0) return;
        _entries.Add(new Entry
        {
            Instance = instance,
            Model = model,
            Morph = morph,
            Next = Time.time + 1.5f + 3f * (float)_random.NextDouble()
        });
    }

    internal static void SetOn(GameObject instance, bool on)
    {
        if (instance == null || instance.WasCollected) return;
        var id = instance.GetInstanceID();
        foreach (var entry in _entries)
        {
            if (entry.Instance == null || entry.Instance.WasCollected || entry.Instance.GetInstanceID() != id) continue;
            entry.Off = !on;
            entry.Start = -1f;
            if (entry.Off) entry.Model.SetMorph(entry.Instance, entry.Morph, 0f);
            else entry.Next = Time.time + 1f + 2f * (float)_random.NextDouble();
        }
    }

    internal static void TickAll()
    {
        if (_entries.Count == 0) return;
        var now = Time.time;
        for (var i = _entries.Count - 1; i >= 0; i--)
        {
            var entry = _entries[i];
            if (entry.Instance == null || entry.Instance.WasCollected) { _entries.RemoveAt(i); continue; }
            if (entry.Off) continue;
            if (entry.Start < 0f)
            {
                if (now < entry.Next) continue;
                entry.Start = now;
            }
            const float length = 0.16f;
            var t = now - entry.Start;
            if (t >= length)
            {
                entry.Start = -1f;
                entry.Next = now + 2f + 4f * (float)_random.NextDouble();
                entry.Model.SetMorph(entry.Instance, entry.Morph, 0f);
            }
            else entry.Model.SetMorph(entry.Instance, entry.Morph, Mathf.Sin(Mathf.PI * t / length) * 100f);
        }
    }
}

/// <summary>导入模型（<see cref="ImportedModel.Spawn"/> 生成的实例）与别的插件的接口：按名字设置表情、开关自动眨眼。</summary>
public static class ImportedModelApi
{
    private static readonly Dictionary<int, ImportedModel> _models = new();

    internal static void Bind(GameObject instance, ImportedModel model)
    {
        _models[instance.GetInstanceID()] = model;
        Blink.Add(instance, model);
    }

    internal static void Unbind(GameObject instance)
    {
        try { _models.Remove(instance.GetInstanceID()); } catch (Exception) { }
    }

    /// <summary>The model an instance <see cref="ImportedModel.Spawn"/> made stands for; null for any other object.</summary>
    public static ImportedModel? ForObject(GameObject? instance)
    {
        if (instance == null || instance.WasCollected) return null;
        return _models.TryGetValue(instance.GetInstanceID(), out var model) ? model : null;
    }

    /// <summary>Sets an expression by its name (0 to 100) on a spawned instance; false when the instance is unknown or has no such expression.
    /// The first call for an expression adds its blend shape to the shared mesh (about 1.5 MB on a character).</summary>
    public static bool SetMorph(GameObject instance, string name, float weight)
    {
        var model = ForObject(instance);
        return model != null && model.SetMorph(instance, model.MorphIndex(name), weight);
    }

    /// <summary>Whether the instance's model carries an expression by this name.</summary>
    public static bool HasMorph(GameObject instance, string name)
    {
        var model = ForObject(instance);
        return model != null && model.MorphIndex(name) >= 0;
    }

    /// <summary>How many expressions the instance's model carries (0 for a model without them).</summary>
    public static int MorphCount(GameObject instance) => ForObject(instance)?.Morphs.Count ?? 0;

    /// <summary>临时诊断（表情为什么写不进去）：第一次 SetMorph 解析到的模型与渲染器。确认后删掉。</summary>

    /// <summary>Turns the automatic blink on or off for an instance: a dance that drives the eyes itself turns it off while it plays.</summary>
    public static void SetBlink(GameObject instance, bool on) => Blink.SetOn(instance, on);
}

/// <summary>
/// Imported models (a player's uploaded <c>.glb</c> or a geomorph's own model, converted to the Forge model package) built from the
/// bytes a caller read and checked: the mesh as a Unity mesh with a submesh per material, the PNGs as textures with mip chains, one
/// lit material (<see cref="LitMaterial"/>) per material record. One cache is one level's models: the same descriptor (<see cref="ImportedModelDescriptor.Key"/>,
/// so two models sharing a mesh with other materials stay apart) is built once, a bad one is refused the same way every time, and <see cref="Dispose"/> destroys every instance, mesh, material and texture it made.
/// The library reads no file and computes no hash: the caller (ForgeEngine) found the bytes, matched them to the descriptor's hashes and
/// decided what a level may hold. Only the draw is here, no collider.
/// </summary>
public sealed class ImportedModels : IDisposable
{
    private readonly Dictionary<string, ImportedModel> _models = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ImportedModelFailure> _failures = new(StringComparer.Ordinal);
    private readonly ImageTextures _images;
    private readonly bool _keep;

    /// <param name="budgetBytes">The most <see cref="ImportedModelDescriptor.EstimatedBytes"/> the cache may hold at once; 0 for no limit. A model
    /// that would pass it is refused with <see cref="ImportedModelCodes.OverBudget"/> and nothing is built.</param>
    /// <param name="keep">For a cache that outlives a level: everything it builds is marked with <see cref="ForgeCore.Assets.Keep"/>, so the game's
    /// unused-asset sweep at a scene change does not unload a mesh, material or texture no instance happens to draw at that moment.</param>
    public ImportedModels(long budgetBytes = 0, bool keep = false)
    {
        BudgetBytes = budgetBytes;
        _keep = keep;
        _images = new ImageTextures(surface: true, keep: keep);
    }

    public long BudgetBytes { get; set; }

    /// <summary>The estimated bytes of the models built so far.</summary>
    public long ResidentBytes { get; private set; }

    public int Count => _models.Count;

    /// <summary>Decodes the PNGs <see cref="Create"/> will need over later frames (<see cref="ForgeCore.Images.Queue(byte[], System.Action{UnityEngine.Texture2D, string}, bool, bool, int, bool, bool)"/>), so creating the
    /// model does not decode them all in one frame: true once every one is decoded or failed (a failure is then refused by <see cref="Create"/>
    /// as before), false while some are still queued. Call it again each frame until it is true; skipping it only moves the decoding into <see cref="Create"/>.</summary>
    public bool Prepare(ImportedModelDescriptor descriptor, IReadOnlyList<byte[]> textures)
    {
        if (_models.ContainsKey(descriptor.Key) || _failures.ContainsKey(descriptor.Key) || textures.Count != descriptor.Textures.Count) return true;
        var ready = true;
        bool One(int index, bool linear, bool normal = false)
        {
            var t = descriptor.Textures[index];
            return _images.Prepare(t.Sha256, textures[index], t.Width, t.Height, linear, normal);
        }
        foreach (var spec in descriptor.Materials)
        {
            if (spec.Glass) continue;
            if (spec.Texture >= 0) ready &= One(spec.Texture, false);
            if (spec.MetalTexture >= 0) ready &= One(spec.MetalTexture, true);
            if (spec.NormalTexture >= 0) ready &= One(spec.NormalTexture, true, normal: true);
            if (spec.Emissive && spec.EmissiveTexture >= 0) ready &= One(spec.EmissiveTexture, false);
        }
        return ready;
    }

    /// <summary>The model of <paramref name="descriptor"/> from its mesh bytes and its PNG textures (in the descriptor's order).</summary>
    public ImportedModelResult Create(ImportedModelDescriptor descriptor, byte[] mesh, IReadOnlyList<byte[]> textures)
    {
        var key = descriptor.Key;
        if (_models.TryGetValue(key, out var built)) return new ImportedModelResult(built, default);
        if (_failures.TryGetValue(key, out var prior)) return new ImportedModelResult(null, prior);
        if (BudgetBytes != 0 && ResidentBytes + descriptor.EstimatedBytes > BudgetBytes)
            return Refuse(descriptor, new ImportedModelFailure(ImportedModelCodes.OverBudget, descriptor.EstimatedBytes + " bytes on top of " + ResidentBytes + " pass the budget of " + BudgetBytes), false);
        // The one file check an exporter runs too (ImportedModelDescriptor.CheckFiles).
        var data = descriptor.ReadFiles(mesh, textures, out var failure);
        if (data == null) return Refuse(descriptor, failure, true);
        if (Shader.Find(LitMaterial.ShaderName) == null)
            return Refuse(descriptor, new ImportedModelFailure(ImportedModelCodes.ShaderUnavailable, "the game's gear shader is not loaded yet; models show once a level has been built"), false);

        var owned = new List<Object>();
        try
        {
            var model = Build(descriptor, data, textures, owned, out failure);
            if (model == null)
            {
                foreach (var o in owned) if (o != null && !o.WasCollected) Object.Destroy(o);
                return Refuse(descriptor, failure, true);
            }
            if (_keep) foreach (var o in owned) ForgeCore.Assets.Keep(o);
            _models.Add(key, model);
            ResidentBytes += descriptor.EstimatedBytes;
            return new ImportedModelResult(model, default);
        }
        catch (Exception error)
        {
            foreach (var o in owned) if (o != null && !o.WasCollected) Object.Destroy(o);
            return Refuse(descriptor, new ImportedModelFailure(ImportedModelCodes.Build, error.Message), true);
        }
    }

    private ImportedModel? Build(ImportedModelDescriptor d, ImportedMesh data, IReadOnlyList<byte[]> pngs, List<Object> owned, out ImportedModelFailure failure)
    {
        failure = default;
        // The mesh file carries no tangents: they are computed for a normal map only.
        var runs = new (int, int)[d.Submeshes.Count];
        for (var i = 0; i < runs.Length; i++) runs[i] = (d.Submeshes[i].IndexStart, d.Submeshes[i].IndexCount);
        var mesh = MeshArrays.Build("Forge imported " + d.MeshSha256[..8], data.Positions, data.Normals, data.Uvs, null, data.Indices,
            runs, computeTangents: d.HasNormalMap);
        owned.Add(mesh);
        // 格式 3 的表情不在建网格时展开：Unity 的混合形状是每个表情、每个顶点各一份，MMD 模型常有 200 个表情、
        // 十几万顶点（全开会占几百 MB）。改为用到哪个才 AddBlendShapeFrame（ImportedModel.EnsureMorph）。
        Matrix4x4[]? rest = null;
        if (d.Bones != null)
        {
            rest = new Matrix4x4[d.Bones.Count];
            var binds = new Matrix4x4[rest.Length];
            for (var b = 0; b < rest.Length; b++)
            {
                var m = d.Bones[b].Rest;
                rest[b] = new Matrix4x4(new Vector4(m[0], m[1], m[2], m[3]), new Vector4(m[4], m[5], m[6], m[7]), new Vector4(m[8], m[9], m[10], m[11]), new Vector4(m[12], m[13], m[14], m[15]));
                binds[b] = rest[b].inverse;
            }
            mesh.boneWeights = new Il2CppStructArray<BoneWeight>(Weights(data));
            mesh.bindposes = new Il2CppStructArray<Matrix4x4>(binds);
        }
        // A skinned mesh stays readable: the game may skin it on the CPU.
        mesh.UploadMeshData(rest == null);

        Texture2D? Decode(ImportedMaterial spec, int index, bool linear, out ImportedModelFailure fault, bool normal = false)
        {
            fault = default;
            var t = d.Textures[index];
            if (_images.TryGet(t.Sha256, pngs[index], t.Width, t.Height, out var decoded, out var code, out var error, linear, normal)) return decoded;
            fault = new ImportedModelFailure(ImportedModelCodes.TextureDecode, spec.Name + ": texture " + index + " (" + code + (error == null ? "" : ", " + error.Message) + ")");
            return null;
        }

        var made = new Material[d.Materials.Count];
        for (var m = 0; m < made.Length; m++)
        {
            var spec = d.Materials[m];
            if (spec.Glass)
            {
                var glass = LitMaterial.Glass("Forge imported " + spec.Name, new Color(spec.BaseColor[0], spec.BaseColor[1], spec.BaseColor[2], spec.BaseColor[3]));
                if (glass == null) { failure = new ImportedModelFailure(ImportedModelCodes.ShaderUnavailable, spec.Name + ": the game's glass shader is not loaded yet"); return null; }
                owned.Add(glass);
                made[m] = glass;
                continue;
            }
            Texture albedo;
            if (spec.Texture >= 0)
            {
                var decoded = Decode(spec, spec.Texture, false, out failure);
                if (decoded == null) return null;
                albedo = decoded;
            }
            else
            {
                albedo = Flat(spec.Name + " colour", linear: false,
                    ImportedColour.LinearToSrgbByte(spec.BaseColor[0]), ImportedColour.LinearToSrgbByte(spec.BaseColor[1]), ImportedColour.LinearToSrgbByte(spec.BaseColor[2]), ImportedColour.UnitToByte(spec.BaseColor[3]));
                owned.Add(albedo);
            }
            // The gear shader reads metal from red and smoothness from green of one map.
            Texture surface;
            if (spec.MetalTexture >= 0)
            {
                var map = Decode(spec, spec.MetalTexture, true, out failure);
                if (map == null) return null;
                surface = map;
            }
            else
            {
                surface = Flat(spec.Name + " surface", linear: true, ImportedColour.UnitToByte(spec.Metallic), ImportedColour.UnitToByte(1f - spec.Roughness), 255, 255);
                owned.Add(surface);
            }
            var material = LitMaterial.Create("Forge imported " + spec.Name, albedo, surface, spec.Cutout, spec.Cutoff, out var why);
            if (material == null)
            {
                failure = new ImportedModelFailure(spec.Cutout ? ImportedModelCodes.CutoutUnsupported : ImportedModelCodes.ShaderUnavailable, spec.Name + ": " + why);
                return null;
            }
            owned.Add(material);
            if (spec.NormalTexture >= 0)
            {
                var normal = Decode(spec, spec.NormalTexture, true, out failure, normal: true);
                if (normal == null) return null;
                LitMaterial.SetRelief(material, normal);
            }
            if (spec.Emissive)
            {
                Texture2D? map = Texture2D.whiteTexture;
                if (spec.EmissiveTexture >= 0)
                {
                    map = Decode(spec, spec.EmissiveTexture, false, out failure);
                    if (map == null) return null;
                }
                const float gain = LitMaterial.EmissionPerUnit;
                Glow.Write(material, new Color(spec.EmissiveColor[0] * gain, spec.EmissiveColor[1] * gain, spec.EmissiveColor[2] * gain, 1f), map);
            }
            made[m] = material;
        }
        var slots = new Material[d.Submeshes.Count];
        for (var i = 0; i < slots.Length; i++) slots[i] = made[d.Submeshes[i].Material];
        return new ImportedModel(d, mesh, slots, owned, rest, data.Morphs, data.Positions.Length / 3);
    }

    /// <summary>Unity's bone weights: each vertex's four, heaviest first.</summary>
    private static BoneWeight[] Weights(ImportedMesh data)
    {
        var index = data.BoneIndices!;
        var weight = data.BoneWeights!;
        var rows = new BoneWeight[index.Length / 4];
        Span<int> order = stackalloc int[4];
        for (var v = 0; v < rows.Length; v++)
        {
            for (var k = 0; k < 4; k++) order[k] = k;
            for (var a = 1; a < 4; a++)
                for (var b = a; b > 0 && weight[v * 4 + order[b]] > weight[v * 4 + order[b - 1]]; b--) (order[b], order[b - 1]) = (order[b - 1], order[b]);
            rows[v] = new BoneWeight
            {
                boneIndex0 = index[v * 4 + order[0]],
                weight0 = weight[v * 4 + order[0]],
                boneIndex1 = index[v * 4 + order[1]],
                weight1 = weight[v * 4 + order[1]],
                boneIndex2 = index[v * 4 + order[2]],
                weight2 = weight[v * 4 + order[2]],
                boneIndex3 = index[v * 4 + order[3]],
                weight3 = weight[v * 4 + order[3]],
            };
        }
        return rows;
    }

    private static Texture2D Flat(string name, bool linear, byte r, byte g, byte b, byte a)
    {
        var texture = new Texture2D(2, 2, TextureFormat.RGBA32, false, linear) { name = "Forge imported " + name };
        var pixel = new Color32(r, g, b, a);
        texture.SetPixels32(new Il2CppStructArray<Color32>(new[] { pixel, pixel, pixel, pixel }));
        texture.Apply(false, true);
        return texture;
    }

    private ImportedModelResult Refuse(ImportedModelDescriptor descriptor, ImportedModelFailure failure, bool remember)
    {
        if (remember) _failures[descriptor.Key] = failure;
        Plugin.Logger.ErrorOnce("visual-imported-model-not-built", "ForgeVisual imported model " + descriptor.MeshSha256[..8] + " was not built, " + failure + ".");
        return new ImportedModelResult(null, failure);
    }

    /// <summary>Destroys every instance and everything the cache built, and forgets the failures.</summary>
    public void Dispose()
    {
        foreach (var model in _models.Values)
        {
            model.DestroySpawned();
            foreach (var o in model.Owned) if (o != null && !o.WasCollected) Object.Destroy(o);
        }
        _models.Clear();
        _failures.Clear();
        ResidentBytes = 0;
        _images.Dispose();
    }
}
