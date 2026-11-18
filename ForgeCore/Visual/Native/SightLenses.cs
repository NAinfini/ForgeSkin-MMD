using System;
using System.Collections.Generic;
using AssetShards;
using ForgeCore;
using GameData;
using UnityEngine;
using Object = UnityEngine.Object;

namespace ForgeVisual;

/// <summary>Where a borrowed lens template stands: its shard is loading (ask again later), it is held, or it cannot be had (<see cref="SightLensTemplate.Failure"/>).</summary>
public enum SightLensState { Loading, Ready, Failed }

/// <summary>One vanilla sight lens material held as a template (<see cref="SightLenses.Of(uint)"/>). <see cref="Material"/> is the library's own copy of the
/// game's material, kept for the process; never put it on a renderer: <see cref="SightLenses.Copy"/> it.</summary>
public sealed class SightLensTemplate
{
    internal SightLensTemplate(string key, string prefab, AssetBundleName bundle, AssetBundleShard shard, string? node, string shader)
    {
        Key = key;
        Prefab = prefab;
        Bundle = bundle;
        Shard = shard;
        Node = node;
        Shader = shader;
    }

    public string Key { get; }
    public string Prefab { get; }
    public string Shader { get; }
    public SightLensState State { get; internal set; }
    public Material? Material { get; internal set; }
    public string? Failure { get; internal set; }
    internal AssetBundleName Bundle { get; }
    internal AssetBundleShard Shard { get; }
    internal string? Node { get; }
    internal bool InFlight;
}

/// <summary>
/// A vanilla sight's lens on any mesh. The game draws a holographic sight's reticle on its flat lens with <see cref="Holographic"/> (the thermal
/// lens with <see cref="Thermal"/>); a copy of that material on another mesh projects the same reticles the same way. The template is the lens material
/// of a vanilla sight prefab, whose shard is loaded through the game's own loader when first asked for: a shard somebody else is loading is waited
/// for, never restarted (the native loader resets the count of an unregistered key), a registered one is counted once more and kept for the process.
/// The copy keeps the shader and textures alive by itself. Users: ForgeEngine's thermal sight, ForgeSkin's sight on an imported model.
/// </summary>
public static class SightLenses
{
    public const string Holographic = "Unlit/HolographicSight_3Layers";
    public const string Thermal = "Unlit/HolographicSight_Thermal";

    /// <summary>A lens is a flat mesh: its thinnest axis at most this many metres (the game's lenses are at most 0.009). A floating hologram
    /// (Sight_20, 21, 24) is a solid volume of 0.03 and more and has no surface to draw a reticle on.</summary>
    public const float LensThickness = 0.02f;

    private static readonly Dictionary<string, SightLensTemplate> Templates = new(StringComparer.Ordinal);
    private static Mesh? _pane;

    /// <summary>The flat <see cref="Holographic"/> lens of the vanilla sight part <paramref name="sightPart"/> (its <c>GearSightPartDataBlock</c>
    /// persistentID). Each call while it is <see cref="SightLensState.Loading"/> looks again, so a caller asks once per tick until it settles.</summary>
    public static SightLensTemplate Of(uint sightPart)
    {
        var key = "part:" + sightPart;
        if (Templates.TryGetValue(key, out var known)) return Advance(known);
        var block = GameDataBlockBase<GearSightPartDataBlock>.GetBlock(sightPart);
        var general = block?.General;
        var made = general == null || string.IsNullOrEmpty(general.Model)
            ? new SightLensTemplate(key, "", default, default, null, Holographic)
            : new SightLensTemplate(key, general.Model, general.AssetBundle, general.BundleShard, null, Holographic);
        Templates[key] = made;
        if (made.Prefab.Length == 0) return Fail(made, "the game has no sight part " + sightPart);
        return Advance(made);
    }

    /// <summary>The material of the renderer at <paramref name="node"/> under <paramref name="prefab"/> in that shard, which must use <paramref name="shader"/>
    /// (the thermal lens of Sight_10_t). Asked again like <see cref="Of(uint)"/>.</summary>
    public static SightLensTemplate Of(string prefab, AssetBundleName bundle, AssetBundleShard shard, string node, string shader)
    {
        var key = prefab + "|" + node + "|" + shader;
        if (!Templates.TryGetValue(key, out var template)) Templates[key] = template = new SightLensTemplate(key, prefab, bundle, shard, node, shader);
        return Advance(template);
    }

    /// <summary>A lens of the caller's own: a copy of the template's material under <paramref name="name"/>, which the caller destroys.</summary>
    public static Material Copy(SightLensTemplate template, string name)
    {
        if (template.State != SightLensState.Ready || template.Material == null) throw new InvalidOperationException("The sight lens " + template.Key + " is not ready.");
        return new Material(template.Material) { name = name };
    }

    /// <summary>A flat mesh renderer with a <see cref="Holographic"/> or <see cref="Thermal"/> material: a lens.</summary>
    public static bool IsLens(Renderer renderer)
    {
        var shader = renderer.sharedMaterial == null || renderer.sharedMaterial.shader == null ? null : renderer.sharedMaterial.shader.name;
        return shader is Holographic or Thermal && IsFlat(renderer);
    }

    /// <summary>The renderer's mesh is flat enough to be a lens (<see cref="LensThickness"/>).</summary>
    public static bool IsFlat(Renderer renderer)
    {
        var filter = renderer.GetComponent<MeshFilter>();
        var mesh = filter == null ? null : filter.sharedMesh;
        if (mesh == null) return false;
        var size = mesh.bounds.size;
        return Mathf.Min(size.x, Mathf.Min(size.y, size.z)) <= LensThickness;
    }

    /// <summary>A copy of <paramref name="glass"/> (same mesh, node and layer) drawn with <paramref name="lens"/> just before it: the glass stays and adds its
    /// reticle on top. The first-person projection weight lives in the glass's property block, which an object copy does not keep, so it is copied too.</summary>
    public static MeshRenderer Duplicate(MeshRenderer glass, Material lens, string name)
    {
        var copy = Object.Instantiate(glass.gameObject, glass.transform.parent, false);
        copy.name = name;
        var renderer = copy.GetComponent<MeshRenderer>();
        renderer.sharedMaterial = lens;
        // Both shaders are in the Transparent queue: the copy draws first.
        lens.renderQueue = glass.sharedMaterial.renderQueue - 1;
        var block = new MaterialPropertyBlock();
        glass.GetPropertyBlock(block);
        renderer.SetPropertyBlock(block);
        return renderer;
    }

    /// <summary>A new pane under <paramref name="parent"/>, <paramref name="size"/> metres wide and high about its centre at the local pose given, its
    /// front facing its local -Z (toward the eye behind a gun), drawn with <paramref name="lens"/> on the parent's layer and casting no shadow.
    /// The caller destroys the object; the quad mesh is the library's, shared and kept.</summary>
    public static MeshRenderer Pane(Transform parent, Vector3 position, Quaternion rotation, Vector2 size, Material lens, string name)
    {
        if (!(size.x > 0f && size.y > 0f) || float.IsInfinity(size.x) || float.IsInfinity(size.y)) throw new ArgumentOutOfRangeException(nameof(size), "A lens pane needs a positive, finite size.");
        var go = new GameObject(name) { layer = parent.gameObject.layer };
        var t = go.transform;
        t.SetParent(parent, false);
        t.localPosition = position;
        t.localRotation = rotation;
        t.localScale = new Vector3(size.x, size.y, 1f);
        go.AddComponent<MeshFilter>().sharedMesh = PaneMesh();
        var renderer = go.AddComponent<MeshRenderer>();
        renderer.sharedMaterial = lens;
        renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        renderer.receiveShadows = false;
        return renderer;
    }

    private static Mesh PaneMesh()
    {
        if (_pane != null) return _pane;
        // A unit quad in XY, its front toward -Z: clockwise seen from -Z (Unity's front faces are clockwise).
        var mesh = MeshArrays.Build("ForgeVisual sight lens",
            new float[] { -0.5f, -0.5f, 0f, -0.5f, 0.5f, 0f, 0.5f, 0.5f, 0f, 0.5f, -0.5f, 0f },
            new float[] { 0f, 0f, -1f, 0f, 0f, -1f, 0f, 0f, -1f, 0f, 0f, -1f },
            new float[] { 0f, 0f, 0f, 1f, 1f, 1f, 1f, 0f },
            null, new[] { 0, 1, 2, 0, 2, 3 });
        mesh.UploadMeshData(true);
        mesh.hideFlags = HideFlags.HideAndDontSave;
        return _pane = mesh;
    }

    private static SightLensTemplate Fail(SightLensTemplate template, string why)
    {
        template.State = SightLensState.Failed;
        template.Failure = why;
        Plugin.Logger.ErrorOnce("visual-sight-lens-unavailable", why + "; no lens is drawn from it.");
        return template;
    }

    private static SightLensTemplate Advance(SightLensTemplate template)
    {
        if (template.State != SightLensState.Loading || template.InFlight) return template;
        if (Take(template)) return template;
        var shard = GameAssets.ShardName(template.Bundle, template.Shard);
        var state = GameAssets.ReadShard(shard);
        if (state.Registered) return Fail(template, "the shard " + shard + " is loaded without " + template.Prefab);
        // Somebody else's load is in flight; the native loader would reset its count.
        if (state.HasCount && state.Count > 0) return template;
        template.InFlight = true;
        GameAssets.LoadShard(template.Bundle, template.Shard, _ =>
        {
            template.InFlight = false;
            if (!Take(template)) Fail(template, "the shard " + shard + " loaded without " + template.Prefab);
        });
        return template;
    }

    /// <summary>True once the prefab is in the loaded-asset table: the template is taken, or the template fails when the prefab has no such lens.</summary>
    private static bool Take(SightLensTemplate template)
    {
        var prefab = GameAssets.Get<GameObject>(template.Prefab);
        if (prefab == null) return false;
        Renderer? source = null;
        if (template.Node != null) source = prefab.transform.Find(template.Node)?.GetComponent<MeshRenderer>();
        else
            foreach (var renderer in prefab.GetComponentsInChildren<MeshRenderer>(true))
                if (renderer.sharedMaterial != null && renderer.sharedMaterial.shader != null && renderer.sharedMaterial.shader.name == template.Shader && IsFlat(renderer))
                {
                    source = renderer;
                    break;
                }
        var material = source == null ? null : source.sharedMaterial;
        if (material == null || material.shader == null || material.shader.name != template.Shader)
        {
            Fail(template, template.Prefab + (template.Node != null ? "/" + template.Node : "") + " has no flat lens drawn with " + template.Shader);
            return true;
        }
        template.Material = new Material(material) { name = "ForgeVisual lens " + material.name, hideFlags = HideFlags.HideAndDontSave };
        template.State = SightLensState.Ready;
        return true;
    }
}
