using ForgeVisual;

namespace ForgeOrdnance;

/// <summary>The mod's one effect library (the bundle <c>forge-ordnance-fx.bundle</c> and its slot table <c>fx-slots.forge</c> in the plugin's
/// <c>Vfx</c> folder, made by <c>Tools/Vfx/FxLibrary/fx_slots.py</c> from the owner's selection), shared by the carrier, Arsenal and the exosuits,
/// and the carrier's moments in it. Which prefab plays for a slot is data in that table, not code here; a slot the table does not list, or an
/// install without the files, logs its error and draws nothing. Playing is ForgeVisual's <see cref="Fx"/>.</summary>
internal static class OrdnanceFxSlots
{
    internal static FxHandle? PodLeave, BeaconImpact, SentryOnline, SentryExpired, Pillar, Ribbon, PodFall, PodGravel, PodLand, PodGlow, PodVent, ServoSparks, ShellUnfold, TurretRise, HandPulse;

    /// <summary>The set every part finds its moments in; <see cref="FxSlots.Empty"/> before <see cref="Load"/> or when the bundle is not shipped.</summary>
    internal static FxSlots Set = FxSlots.Empty;

    /// <summary>Reads the library, once, before any part finds its moments in it (the plugin runs it first for any call-in), then finds the carrier's.</summary>
    internal static void Load()
    {
        var set = Set = FxSlots.Load(Plugin.Id, "OrdnanceFx", "Vfx/forge-ordnance-fx.bundle", "Vfx/fx-slots.forge");
        Pillar = set.Find("beacon.pillar");
        Ribbon = set.Find("beacon.ribbon");
        PodLeave = set.Find("pod.leave");
        BeaconImpact = set.Find("beacon.impact");
        SentryOnline = set.Find("sentry.online");
        SentryExpired = set.Find("sentry.expired");
        PodFall = set.Find("pod.fall"); PodGravel = set.Find("pod.gravel"); PodLand = set.Find("pod.land"); PodGlow = set.Find("pod.glow");
        PodVent = set.Find("pod.vent"); ServoSparks = set.Find("mech.servo.sparks"); ShellUnfold = set.Find("shell.unfold");
        TurretRise = set.Find("turret.rise"); HandPulse = set.Find("hand.pulse");
    }
}
