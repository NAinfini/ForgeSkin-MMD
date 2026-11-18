using System;
using System.Collections.Generic;
using GameData;
using Gear;
using Player;

namespace ForgeVisual;

/// <summary>
/// An item's first-person settings and aim zoom changed for one item without touching the game's blocks: every gun built on a settings block or a sight
/// part shares that block, so the item is given copies. The game reads the aim fields of view from the sight part first
/// (<c>ItemEquippable.GetItemFovZoom</c> takes <c>SightProperties.GearFovZoom</c>, <c>GetWorldCameraZoomFov</c> takes <c>WorldFovZoom</c>, when above 0;
/// disassembly of Build 20403457) and only then from the settings block (<c>ItemCameraFOVZoom</c>, <c>LookCameraFOVZoom</c>), so an aim zoom goes on
/// both: the settings copy, and a copy of the sight part (with its own copy of <c>SightProperties</c>) in the gun's <c>GearPartHolder.SightData</c>.
/// A copy is made once per (block, change) and kept, as the game keeps its blocks. <see cref="Restore"/> gives the item its blocks back; the game
/// reads the hip position and hip item field of view only when its hip state takes the item, so a change while the local gun sits at the hip has the
/// hip state take it again. Users: <see cref="GunMount"/> (the hold rule and a mounted sight's zoom), ForgeSkin (a skin's sight zoom).
/// </summary>
public static class HeldSettings
{
    private sealed class Worn
    {
        internal ItemEquippable Item = null!;
        internal string Key = "", Change = "";
        internal ItemFPSSettingsDataBlock? Settings, SettingsCopy;
        internal GearPartHolder? Holder;
        internal GearSightPartDataBlock? Sight, SightCopy;
    }

    private static readonly Dictionary<IntPtr, Worn> ByItem = new();
    private static readonly Dictionary<(IntPtr Block, string Key), ItemFPSSettingsDataBlock> SettingsCopies = new();
    private static readonly Dictionary<(IntPtr Block, int Item, int World), GearSightPartDataBlock> SightCopies = new();
    private static readonly HashSet<IntPtr> Copies = new();

    /// <summary>The first-person settings the item wears now (its gear's, else its item's).</summary>
    public static ItemFPSSettingsDataBlock? Settings(ItemEquippable item) => item.m_itemFPSSettingsForGear ?? item.m_itemFPSSettingsForItem;

    /// <summary>True while the item wears a copy put on by <see cref="Wear"/> under <paramref name="key"/>.</summary>
    public static bool Wears(ItemEquippable item, string key)
        => ByItem.TryGetValue(item.Pointer, out var worn) && worn.Key == key && Live(worn) && Settings(item) is { } now && now.Pointer == worn.SettingsCopy?.Pointer;

    /// <summary>
    /// Puts on <paramref name="item"/> a copy of its settings changed by <paramref name="edit"/> (given the game's block and the copy) and, when
    /// <paramref name="aimItemFov"/> or <paramref name="aimWorldFov"/> is above 0 (whole degrees, as the game stores them; 0 keeps the game's), that aim
    /// zoom. <paramref name="key"/> names the change: the same key and zoom on the same block share one copy, so <paramref name="edit"/> runs once
    /// per block and must depend on nothing else. An item that wears another change is given its own blocks back first.
    /// </summary>
    public static void Wear(ItemEquippable item, string key, Action<ItemFPSSettingsDataBlock, ItemFPSSettingsDataBlock>? edit, int aimItemFov = 0, int aimWorldFov = 0)
    {
        if (item == null) throw new ArgumentNullException(nameof(item));
        if (aimItemFov < 0 || aimWorldFov < 0) throw new ArgumentOutOfRangeException(aimItemFov < 0 ? nameof(aimItemFov) : nameof(aimWorldFov), "An aim field of view is 0 (the game's) or above.");
        var change = key + "|" + aimItemFov + "|" + aimWorldFov;
        // Items the game destroyed (a level rebuilt, a checkpoint reloaded) are forgotten: their new gear starts on the game's blocks.
        List<IntPtr>? dead = null;
        foreach (var (pointer, entry) in ByItem)
            if (pointer != item.Pointer && !Live(entry)) (dead ??= new()).Add(pointer);
        if (dead != null) foreach (var pointer in dead) ByItem.Remove(pointer);
        if (ByItem.TryGetValue(item.Pointer, out var worn))
        {
            if (worn.Change == change && Live(worn) && Settings(item) is { } now && now.Pointer == worn.SettingsCopy?.Pointer) return;
            Restore(item);
        }
        var original = Settings(item);
        if (original == null) return;
        worn = new Worn { Item = item, Key = key, Change = change, Settings = original };
        if (!SettingsCopies.TryGetValue((original.Pointer, change), out var copy))
        {
            copy = original.MemberwiseClone().Cast<ItemFPSSettingsDataBlock>();
            edit?.Invoke(original, copy);
            if (aimItemFov > 0) copy.ItemCameraFOVZoom = aimItemFov;
            if (aimWorldFov > 0) copy.LookCameraFOVZoom = aimWorldFov;
            SettingsCopies[(original.Pointer, change)] = copy;
            Copies.Add(copy.Pointer);
        }
        worn.SettingsCopy = copy;
        // The native setter resolves the recoil animation again from the copy, which names the same one.
        item.SetItemFPSSettingsForGear(copy);
        var holder = item.GearPartHolder;
        if ((aimItemFov > 0 || aimWorldFov > 0) && holder != null && holder.SightData is { } sight && sight.SightProperties != null)
        {
            if (!SightCopies.TryGetValue((sight.Pointer, aimItemFov, aimWorldFov), out var sightCopy))
            {
                sightCopy = sight.MemberwiseClone().Cast<GearSightPartDataBlock>();
                var properties = sight.SightProperties.MemberwiseClone().Cast<GearSightPartProperties>();
                if (aimItemFov > 0) properties.GearFovZoom = aimItemFov;
                if (aimWorldFov > 0) properties.WorldFovZoom = aimWorldFov;
                sightCopy.SightProperties = properties;
                SightCopies[(sight.Pointer, aimItemFov, aimWorldFov)] = sightCopy;
                Copies.Add(sightCopy.Pointer);
            }
            worn.Holder = holder;
            worn.Sight = sight;
            worn.SightCopy = sightCopy;
            holder.SightData = sightCopy;
        }
        ByItem[item.Pointer] = worn;
        Resettle(item);
    }

    /// <summary>Gives <paramref name="item"/> back the blocks it wore before <see cref="Wear"/>; nothing when it wears none of this library's copies.</summary>
    public static void Restore(ItemEquippable item)
    {
        if (item == null || !ByItem.Remove(item.Pointer, out var worn)) return;
        if (item.WasCollected) return;
        if (worn.Settings != null && Settings(item) is { } now && Copies.Contains(now.Pointer))
        {
            item.SetItemFPSSettingsForGear(worn.Settings);
            Resettle(item);
        }
        if (worn.Holder != null && !worn.Holder.WasCollected && worn.Holder.SightData is { } sight && Copies.Contains(sight.Pointer)) worn.Holder.SightData = worn.Sight;
    }

    private static bool Live(Worn worn) => worn.Item != null && !worn.Item.WasCollected;

    /// <summary>The game reads the hip position and item field of view once, when the hip state takes the wielded item (<c>FPIS_Hip.SetupWieldedItem</c>).
    /// Settings changed while the local first-person gun already sits at the hip would wait for the next state change, so the hip state takes the item again.</summary>
    internal static void Resettle(ItemEquippable item)
    {
        if (!item.IsFirstPerson) return;
        var hands = item.Owner != null ? item.Owner.FPItemHolder : null;
        if (hands == null || hands.WieldedItem == null || hands.WieldedItem.Pointer != item.Pointer || hands.m_currentState != FPItemStateName.Hip) return;
        hands.m_itemStates[(int)FPItemStateName.Hip].Cast<FirstPersonItem.FPIS_Hip>().SetupWieldedItem();
    }
}
