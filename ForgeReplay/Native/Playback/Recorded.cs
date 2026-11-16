using System;
using System.Collections.Generic;
using ForgeCore;
using Player;
using UnityEngine;

namespace ForgeReplay;

/// <summary>What the recording says about its players at the replay's moment, for every layer that shows them (the stand-ins, the first-person
/// view, the screen, a sentry's model): who holds each slot, the gear lines they carry, how fast they move. Read from the recording alone; no
/// layer reads another's objects for it. Main thread only.</summary>
internal static class Recorded
{
    /// <summary>The gear lines of a loadout (standard, special, melee, tool), and the inventory slots they fill in that order.</summary>
    internal const int GearLines = 4;
    internal static readonly InventorySlot[] GearSlots = { InventorySlot.GearStandard, InventorySlot.GearSpecial, InventorySlot.GearMelee, InventorySlot.GearClass };

    /// <summary>The line of the tool (the class slot) in a loadout.</summary>
    internal const int ToolLine = 3;

    /// <summary>The loadout line of the inventory slot <paramref name="wield"/> (<see cref="GearSlots"/>), -1 for a slot that is not gear.</summary>
    internal static int LineIndex(int wield) => Array.IndexOf(GearSlots, (InventorySlot)wield);

    /// <summary>The gear line of the weapon held in <paramref name="wield"/>: the loadout's lines are standard, special, melee, tool.</summary>
    internal static string GearLineOf(string loadout, int wield)
    {
        var line = LineIndex(wield);
        return line < 0 ? "" : LineAt(loadout, line);
    }

    /// <summary>The loadout line after the gear: the outfit (vanity item IDs of the helmet, torso, legs, backpack and palette, 0 for the
    /// character's default); "" in a file written before the outfit was recorded.</summary>
    internal static string OutfitOf(string loadout) => LineAt(loadout, GearLines);

    /// <summary>The loadout line after the outfit: the look (ForgeCore's look provider id and its description in base64, space separated);
    /// "" when the game's own body showed.</summary>
    internal static string LookOf(string loadout) => LineAt(loadout, GearLines + 1);

    // Split once per loadout (a frame asks for every player's gear): the lines are kept by the loadout text until the replay ends.
    private static string LineAt(string loadout, int index)
    {
        if (!Split.TryGetValue(loadout, out var lines)) Split[loadout] = lines = Array.ConvertAll(loadout.Split('\n'), l => l.Trim());
        return index < lines.Length ? lines[index] : "";
    }

    private static readonly Dictionary<string, string[]> Split = new();

    // Who holds each slot now: the file header's player, then the Presence lines up to this moment (a join, a leave, a changed loadout). Read again when a line passes.
    private static readonly SlotHolder[] Holders = new SlotHolder[4];
    private static int _presenceSeen = -1;
    private static readonly IReadOnlyList<PresenceLine> NoLines = Array.Empty<PresenceLine>();

    /// <summary>The recording's joins, leaves and changed loadouts.</summary>
    internal static IReadOnlyList<PresenceLine> Lines => Replayer.Report?.Presence ?? NoLines;

    /// <summary>Once a frame, before anything reads a holder.</summary>
    internal static void Read(uint nowMs, IReadOnlyList<PlayerEntry> recorded)
    {
        var seen = ReplayFeed.PresenceUpTo(Lines, nowMs);
        if (seen == _presenceSeen) return;
        _presenceSeen = seen;
        for (var slot = 0; slot < 4; slot++) Holders[slot] = ReplayFeed.Holder(slot, nowMs, recorded, Lines, "");
    }

    internal static void Clear() { _presenceSeen = -1; Split.Clear(); }

    /// <summary>Who holds <paramref name="slot"/> at this moment.</summary>
    internal static SlotHolder Holder(int slot) => Holders[slot & 3];

    /// <summary>The gear lines the player of <paramref name="slot"/> carries at this moment.</summary>
    internal static string LoadoutOf(int slot) => Holders[slot & 3].Loadout ?? "";

    /// <summary>How fast the entity moves over the ground between its latest sample and the next.</summary>
    internal static Vector3 Velocity(WorldState state, int entity, uint nowMs)
    {
        ref var p = ref state.Poses[entity];
        if (!p.Present || !p.HasNext) return Vec.Zero;
        var (vx, vz) = PuppetMotion.Velocity(p.X, p.Z, p.NextX, p.NextZ, (p.NextMs - p.TimeMs) / 1000f);
        return new Vector3(vx, 0f, vz);
    }
}
