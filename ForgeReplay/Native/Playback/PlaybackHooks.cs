using System;
using HarmonyLib;

namespace ForgeReplay;

/// <summary>The game methods only a replay changes: put on the first time a replay starts (<see cref="Begin"/>) and left on, since the game keeps
/// a detour for a patched method after an unpatch; each patch body does nothing unless <see cref="Replayer.Active"/>, so an ordinary game runs
/// as before. The room tone and an enemy's sound reach follow the view (<see cref="Listening"/>); the foam is what the recording says. Main thread only.</summary>
internal static class PlaybackHooks
{
    private static readonly ForgeCore.LazyPatches Hooks = ForgeCore.Patches.Lazy(Plugin.Id + ".playback", harmony =>
    {
        foreach (var feature in new[] { typeof(Listening.RoomTone), typeof(Listening.EnemyReach), typeof(FoamAsRecorded) })
            try { harmony.CreateClassProcessor(feature).Patch(); }
            catch (Exception error) { Plugin.Logger.Error("The replay's " + feature.Name + " hook could not be put on, so that part is as the game does it: " + error.Message); }
    });

    internal static void Begin() => Hooks.Ensure();

    // A blob in the air flies until its recorded landing, and foam settles nothing with anything it touches.
    [HarmonyPatch]
    private static class FoamAsRecorded
    {
        [HarmonyPatch(typeof(GlueGunProjectile), nameof(GlueGunProjectile.CollisionCheck))]
        [HarmonyPrefix]
        private static bool NoLanding(ref bool __result)
        {
            if (!Replayer.Active) return true;
            __result = false;
            return false;
        }

        [HarmonyPatch(typeof(GlueGunProjectile), nameof(GlueGunProjectile.OnTriggerEnter))]
        [HarmonyPrefix]
        private static bool NoTouch() => !Replayer.Active;
    }
}
