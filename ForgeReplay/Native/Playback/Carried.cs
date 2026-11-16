using ForgeCore;
using System;
using System.Collections.Generic;
using System.Linq;
using LevelGeneration;
using Player;
using UnityEngine;

namespace ForgeReplay;

/// <summary>A big item a player carries in the hands (a cell, a turbine, a neonate): the recording has the pickup's state with its holder
/// (27 ItemState's holder slot) and the holder's wielded slot. The game hides the level's item when it is picked up and the carried copy lives
/// in the holder's backpack, which a replay does not touch, so the level's own item is shown at the right hand of the player's stand-in for as long as the recording has it
/// held in the hands, and the stand-in puts what it holds away for as long. Display only: its state, interaction and objective are the setter's and the game's, and its
/// colliders are off while it is carried. What the level has no object for in the hands (a resource pack, a consumable, a carried item whose pickup was not matched) the
/// stand-in holds itself (Puppeteer, StandIn.Hold). A stand-in that is not shown (the player is away, or the camera is at its eyes, where the hands are the observer's own
/// first-person arms: <see cref="FirstPerson"/>) has no hand, so nothing is shown for it. Main thread only.</summary>
internal static class Carried
{
    private const ulong PickedUp = (ulong)ePickupItemStatus.PickedUp;

    private sealed class Shown
    {
        internal LG_PickupItem_Sync Item = null!;
        internal GameObject Root = null!;
        internal readonly List<Collider> Off = new();
        internal bool Seen;
    }

    private static readonly Dictionary<ulong, Shown> Held = new();
    private static readonly List<ulong> Gone = new();
    private static readonly bool[] LevelItemHeld = new bool[4];

    /// <summary>Per frame, from the state alone (a jump needs nothing else).</summary>
    internal static void Frame(WorldState state)
    {
        foreach (var shown in Held.Values) shown.Seen = false;
        Array.Clear(LevelItemHeld);
        if (EventPresenter.Setter is { } setter)
            foreach (var ((kind, key), payload) in state.Objects)
            {
                if (kind != EventKind.ItemState) continue;
                var read = PayloadReader.Over(payload);
                read.U();
                if (read.U() != PickedUp) continue;
                read.U(); read.Pos();
                var holder = read.U();
                if (holder == 0) continue;
                var slot = (int)(holder - 1) & 3;
                if (!InHands(state, slot) || setter.Known(key) is not { } item) continue;
                if (!Place(slot, out var at, out var rotation)) continue;
                if (!Held.TryGetValue(key, out var shown))
                {
                    if (RootOf(item) is not { } root) continue;
                    Held[key] = shown = new Shown { Item = item, Root = root };
                }
                shown.Seen = true;
                LevelItemHeld[slot] = true;
                Show(shown, at, rotation);
            }
        Gone.Clear();
        foreach (var (key, shown) in Held) if (!shown.Seen) { Put(shown); Gone.Add(key); }
        foreach (var key in Gone) Held.Remove(key);
        for (var slot = 0; slot < 4; slot++)
            if (Puppeteer.StandInOf(slot) is { } body) body.Covered = LevelItemHeld[slot];
    }

    internal static string Inspect() => string.Join("; ", new[] { 0, 1, 2, 3 }.Select(s => s + ": covered=" + (Puppeteer.StandInOf(s)?.Covered ?? false))) + " level items=" + Held.Count;

    /// <summary>The replay ends: every carried item goes back to the state the game has it in.</summary>
    internal static void Clear()
    {
        foreach (var shown in Held.Values) Put(shown);
        Held.Clear();
    }

    // The carried item's own object, the one the game hides on a pickup (CarryItemPickup_Core); null for any other pickup.
    private static GameObject? RootOf(LG_PickupItem_Sync item)
    {
        var core = item.GetComponent<CarryItemPickup_Core>();
        if (core == null) { var up = item.GetComponentsInParent<CarryItemPickup_Core>(true); if (up.Length > 0) core = up[0]; }
        return core != null ? core.gameObject : null;
    }

    private static bool InHands(WorldState state, int slot)
    {
        var status = state.PlayerStatus[slot];
        if (status == null) return false;
        var read = PayloadReader.Over(status);
        read.U(); read.U();
        return (InventorySlot)read.U() == InventorySlot.InLevelCarry;
    }

    // At the body's right hand, turned with its body.
    private static bool Place(int slot, out Vector3 at, out Quaternion rotation)
    {
        at = default; rotation = Vec.Identity;
        var body = Puppeteer.AnimatorOf(slot);
        var hand = body != null ? body.GetBoneTransform(HumanBodyBones.RightHand) : null;
        if (body == null || hand == null) return false;
        at = hand.position;
        rotation = Quaternion.Euler(0f, body.transform.eulerAngles.y, 0f);
        return true;
    }


    private static void Show(Shown shown, Vector3 at, Quaternion rotation)
    {
        try
        {
            var item = shown.Root;
            if (!item.activeSelf) item.SetActive(true);
            if (shown.Off.Count == 0)
                foreach (var collider in item.GetComponentsInChildren<Collider>(false))
                    if (collider != null && collider.enabled) { collider.enabled = false; shown.Off.Add(collider); }
            item.transform.SetPositionAndRotation(at, rotation);
        }
        catch (Exception error) { Skipped.Note("a carried item could not be shown in the hands", error.Message); }
    }

    // Back to how the game has it: put down (the setter placed it), or still picked up and only out of the hands (hidden, as the game hides it).
    private static void Put(Shown shown)
    {
        try
        {
            if (shown.Item == null || shown.Item.WasCollected) return;
            foreach (var collider in shown.Off) if (collider != null && !collider.WasCollected) collider.enabled = true;
            shown.Off.Clear();
            if (shown.Item.GetCurrentState().status == ePickupItemStatus.PickedUp && shown.Root != null) shown.Root.SetActive(false);
        }
        catch (Exception error) { Plugin.Logger.ErrorOnce("A carried item could not be put back: " + error.Message); }
    }
}
