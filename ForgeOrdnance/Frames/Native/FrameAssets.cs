using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using ForgeVisual;
using UnityEngine;
using Object = UnityEngine.Object;

namespace ForgeOrdnance.Frames;

/// <summary>Frames/forge-frames.bundle next to the plugin, registered with ForgeVisual (<see cref="Bundles.Register"/>) as the pack
/// <see cref="Pack"/> at plugin load. Registration reads only the bundle's names; a suit's prefabs and gear-shaded materials are loaded
/// when a level that can call it in is built (<see cref="Prepare"/>, after <see cref="LevelBuilt"/>), or at its first spawn. A suit's model and its launcher's parts are ForgeVisual
/// <c>Pack:item</c> names of any pack (this one or another mod's). Each suit prefab holds one skinned renderer and a legacy Animation
/// with the opening clips open and close; a worn suit's limbs follow its pilot's own game body.</summary>
internal static class FrameAssets
{
    internal const string Pack = "Frames";
    internal const string BundleFile = "Frames/forge-frames.bundle";
    private static BundleHandle? _registered;

    /// <summary>This plugin's own pack once a level has been built (before that nothing can be spawned or worn), else null.</summary>
    internal static BundleHandle? Bundle { get; private set; }
    internal static string? Failure { get; private set; }

    /// <summary>Plugin load: registers the pack, so definitions that name its prefabs pass admission.</summary>
    internal static void Register()
    {
        try
        {
            _registered = Bundles.Register(Plugin.Id, Pack, BundleFile)
                ?? throw new InvalidDataException("ForgeVisual did not register " + BundleFile + " (its error is in the log)");
        }
        catch (Exception error)
        {
            Failure = error.Message;
            Plugin.Logger.ErrorOnce("Exosuit art could not be loaded; suits cannot be shown or boarded: " + error);
        }
    }

    internal static void LevelBuilt()
    {
        Bundle = _registered;
        FrameHudArt.Settle();
    }

    /// <summary>Definition admission, which loads nothing: the suit's model and, with rockets, its launcher and rocket must be <c>Pack:item</c>
    /// names of a registered ForgeVisual pack that lists that item, so a definition naming missing art never becomes a selectable,
    /// chargeable call. Their parts are checked when the art is loaded (<see cref="Prepare"/>). The cockpit mark (<see cref="FrameHudArt.Expect"/>)
    /// is checked once after the first level is built, when every icon pack is registered; ForgeUI writes the one error line when it is
    /// missing, the suit still works.</summary>
    internal static void RequireArt(FrameSpec spec)
    {
        var launcher = spec.Rockets?.Launcher;
        var field = "Model";
        try
        {
            // A body model: a worn suit follows its pilot's pose and holds what the pilot holds in its right hand (FrameVisual), and a
            // replay makes the same copy from this declaration.
            Model(spec.Model).FollowsBodies(FrameBodyRig.PoseLinks, FrameBodyRig.ArmReach, FrameBodyRig.RightHandLink);
            if (launcher != null)
            {
                field = "Rockets.Launcher.Pod";
                Model(launcher.Pod);
                field = "Rockets.Launcher.Round";
                Model(launcher.Round);
            }
        }
        catch (Exception error) { throw new ForgeCore.StrictJsonException(field, error.Message); }
        FrameHudArt.Expect(spec.Model);
    }

    private static ModelHandle Model(string name)
    {
        if (!ForgeCore.PackItem.TrySplit(name, out var pack, out var item)) throw new InvalidDataException("'" + name + "' is not Pack:item.");
        if (!Bundles.TryGet(pack, out var bundle))
            throw new InvalidDataException("no ForgeVisual pack '" + pack + "' is registered" + (pack == Pack && Failure != null ? " (" + Failure + ")" : "; its mod must register it with Bundles.Register in its plugin Load"));
        return bundle.TryModel(item, out var model) ? model : throw new InvalidDataException("pack '" + pack + "' has no prefab '" + item + "'.");
    }

    private static readonly Dictionary<FrameSpec, bool> Prepared = new();

    /// <summary>Loads the art of <paramref name="spec"/> and makes it ready to spawn, once: while a level that can call the suit in is built,
    /// else at its first spawn or shell. The parts are checked on the loaded prefabs: the suit's model has a skinned renderer, every bone
    /// and node its definition names (<see cref="FrameBodyRig"/>) and, when it opens, an Animation; with rockets, the launcher has one mesh
    /// renderer and the tube <see cref="FrameRocketRack.FirstMuzzle"/> and the rocket one mesh renderer. False, with one error naming the
    /// field, when the art is missing or a part is: that suit is then not shown or boarded, as without its art. The opening clips are read
    /// from the spawned suit (<see cref="FrameVisual"/>): a legacy Animation's clips are not read from a prefab that was never instantiated.</summary>
    internal static bool Prepare(FrameSpec spec)
    {
        if (Prepared.TryGetValue(spec, out var done)) return done;
        // Only in a level (the materials need the game's gear shader): a suit placed or called in that no pick listed is prepared here.
        if ((Bundle ??= _registered) == null) return false;
        var launcher = spec.Rockets?.Launcher;
        var field = "Model";
        try
        {
            var model = Model(spec.Model);
            var suit = model.Prefab;
            if (suit.GetComponentsInChildren<SkinnedMeshRenderer>(true).Length == 0)
                throw new InvalidDataException("Model '" + spec.Model + "' has no skinned renderer.");
            var missing = FrameBodyRig.MissingNodes(spec, name => Models.Find(suit.transform, name) != null).ToList();
            if (missing.Count > 0)
            {
                field = missing[0].Field;
                throw new InvalidDataException("Model '" + spec.Model + "' lacks " + string.Join(", ", missing.Select(m => m.Field + " -> '" + m.Node + "'")) + ".");
            }
            field = "Opening";
            if (spec.Opening != null && suit.GetComponentInChildren<Animation>(true) == null)
                throw new InvalidDataException("Model '" + spec.Model + "' has no Animation for its open and close clips.");
            field = "Model";
            if (!model.Ready) throw new InvalidDataException("Model '" + spec.Model + "' could not be prepared (ForgeVisual logged why).");
            if (launcher != null)
            {
                field = "Rockets.Launcher.Pod";
                var pod = Model(launcher.Pod);
                if (pod.Prefab.GetComponentsInChildren<MeshRenderer>(true).Length != 1) throw new InvalidDataException("Launcher '" + launcher.Pod + "' must have one mesh renderer.");
                if (Models.Find(pod.Prefab.transform, FrameRocketRack.FirstMuzzle) == null) throw new InvalidDataException("Launcher '" + launcher.Pod + "' has no tube " + FrameRocketRack.FirstMuzzle + ".");
                if (!pod.Ready) throw new InvalidDataException("Launcher '" + launcher.Pod + "' could not be prepared (ForgeVisual logged why).");
                field = "Rockets.Launcher.Round";
                var round = Model(launcher.Round);
                if (round.Prefab.GetComponentsInChildren<MeshRenderer>(true).Length != 1) throw new InvalidDataException("Rocket '" + launcher.Round + "' must have one mesh renderer.");
                if (!round.Ready) throw new InvalidDataException("Rocket '" + launcher.Round + "' could not be prepared (ForgeVisual logged why).");
            }
            PilotBody.Load();
            return Prepared[spec] = true;
        }
        catch (Exception error)
        {
            Plugin.Logger.ErrorOnce("Exosuit '" + spec.Model + "' is not shown or boarded: " + field + ": " + error.Message);
            return Prepared[spec] = false;
        }
    }

    /// <summary>A new instance of the suit model of <paramref name="spec"/> (<c>Pack:item</c>) with its game-shaded materials (ForgeVisual's
    /// <see cref="ModelHandle.Spawn"/>, which covers skinned renderers), after <see cref="Prepare"/>; null (logged) when the art is missing.</summary>
    internal static GameObject? Spawn(FrameSpec spec, Vector3 position, Quaternion rotation)
    {
        var model = spec.Model;
        if (!Prepare(spec) || Models.Get(model) is not { } handle) return null;
        var instance = handle.Spawn(position, rotation);
        if (instance == null) return null;
        var renderers = instance.GetComponentsInChildren<SkinnedMeshRenderer>(true);
        if (renderers.Length == 0) { Object.Destroy(instance); Plugin.Logger.ErrorOnce("Exosuit model '" + model + "' has no skinned renderer."); return null; }
        return instance;
    }

    /// <summary>A new instance of the part <paramref name="prefab"/> (<c>Pack:item</c>, a launcher or a rocket, checked by
    /// <see cref="Prepare"/>) under <paramref name="parent"/>, or null (logged) when the art is missing.</summary>
    internal static GameObject? SpawnProp(string prefab, Vector3 position, Quaternion rotation, Transform? parent)
        => Bundle == null || Models.Get(prefab) is not { } handle ? null : handle.Spawn(position, rotation, parent);
}
