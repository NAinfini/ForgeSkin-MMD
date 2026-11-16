using System;
using System.Collections.Generic;
using Player;
using UnityEngine;

namespace ForgeReplay;

/// <summary>Records what every player's third-person body plays, as PlayerAnimLayer states (event 113: U player slot x 16 + layer, S state number,
/// S the recording time the state began at, U cross-fade in milliseconds, U the layer's weight in tenths), written when a layer's state or weight
/// changes or a state starts again. A remote player's and a bot's body is read every frame (<see cref="Read"/>); the recorder's own player's body does
/// not play these states, so they are made from what the player does (<see cref="Local"/>, table in <see cref="BodyStates"/>). Main thread only.</summary>
internal static class BodyRecorder
{
    private static readonly (int State, int Weight)[] Last = new (int, int)[4 * BodyStates.Layers];
    private static readonly float[] LastTime = new float[4 * BodyStates.Layers];
    private static readonly IntPtr[] Agents = new IntPtr[4];
    private static readonly Animator?[] Bodies = new Animator?[4];
    internal static readonly int AimParameter = Animator.StringToHash("AimDownUp");

    internal static void Reset()
    {
        Array.Clear(Last); Array.Clear(LastTime); Array.Clear(Agents); Array.Clear(Bodies);
        Pending.Clear(); _localSlot = -1; _item = IntPtr.Zero; _itemAt = 0; _wield = -1; _family = BodyStates.RifleFamily; _left = _right = 0; _melee = null; ReadMelee();
        _jumped = false; _downAt = _reviveUntil = _actionUntil = _recoilUntil = 0; _action = 0;
    }

    /// <summary>The player's body animator, taken once per agent (the property makes a wrapper each time).</summary>
    internal static Animator? BodyOf(PlayerAgent agent, int slot)
    {
        if (Agents[slot] != agent.Pointer) { Agents[slot] = agent.Pointer; Bodies[slot] = agent.AnimatorBody; }
        return Bodies[slot];
    }

    private static void Write(int slot, int layer, int state, long startMs, int fadeMs, int weight)
    {
        Last[slot * BodyStates.Layers + layer] = (state, weight);
        var key = BodyStates.Key(slot, layer);
        Rec.Begin().U(key).S(state).S(startMs).U((ulong)fadeMs).U((ulong)weight);
        Rec.EmitState(EventKind.PlayerAnimLayer, key);
    }

    /// <summary>One frame's read of a body another machine (or a bot) drives. A state the layer is fading into is the layer's state from the fade's start.</summary>
    internal static void Read(PlayerAgent agent, int slot, uint now)
    {
        var body = BodyOf(agent, slot);
        if (body == null) return;
        foreach (var layer in BodyStates.Recorded)
        {
            var fading = body.IsInTransition(layer);
            var info = fading ? body.GetNextAnimatorStateInfo(layer) : body.GetCurrentAnimatorStateInfo(layer);
            var state = info.shortNameHash;
            var time = info.normalizedTime;
            var weight = Mathf.RoundToInt(body.GetLayerWeight(layer) * BodyStates.FullWeight);
            var at = slot * BodyStates.Layers + layer;
            var last = Last[at];
            // The same state with its time gone back started again (a second swing, the same weapon brought up twice).
            var again = last.State == state && time < LastTime[at] - 0.05f;
            LastTime[at] = time;
            if (last.State == state && last.Weight == weight && !again) continue;
            var played = (info.loop ? time - MathF.Floor(time) : time) * info.length;
            Write(slot, layer, state, now - (long)(played * 1000f), fading && (last.State != state || again) ? BodyStates.FadeMs : 0, weight);
        }
    }

    // What the local player did since the last frame, noted as the recorder writes the events (Rec.Emit): the kind and its number after the slot.
    private static readonly List<(ushort Kind, int Value)> Pending = new();
    private static readonly PayloadReader Reader = new();
    private static int _localSlot = -1;

    internal static void Note(ushort kind, ReadOnlySpan<byte> payload)
    {
        if (_localSlot < 0 || kind is not (EventKind.Interact or EventKind.Throw or EventKind.Melee or EventKind.MeleeCharge or EventKind.Shot)) return;
        var read = Reader.Load(payload);
        // Bounded: a frame has a handful of these, and a frame whose Local read never comes (an earlier poll of the player threw) must not let them pile up.
        if ((int)read.U() != _localSlot || Pending.Count >= 64) return;
        Pending.Add((kind, kind == EventKind.Shot ? 0 : (int)read.U()));
    }

    // The wielded item's part of the table, read when the item changes (looked at four times a second and at every change of the wielded slot).
    private static IntPtr _item;
    private static uint _itemAt;
    private static int _wield = -1, _family = BodyStates.RifleFamily, _left, _right;
    private static GameData.MeleeAnimationSetDataBlock? _melee;
    private static bool _jumped;
    private static uint _downAt, _reviveUntil, _actionUntil, _recoilUntil;
    private static int _action;

    private static int Hash(string? name) => string.IsNullOrEmpty(name) ? 0 : Animator.StringToHash(name);

    // The melee weapon's animation names as state hashes, worked out when the wielded item changes (never per frame).
    private static string? _idle;
    private static int _idleHash, _idleCrouchHash, _chargeHash, _chargeCrouchHash, _swingHash, _swingCrouchHash, _releaseHash, _releaseCrouchHash, _shoveHash, _shoveCrouchHash, _equipHash;

    private static void ReadMelee()
    {
        var m = _melee;
        _idle = m?.TPAnimHashIdle?.Name;
        _idleHash = Hash(_idle); _idleCrouchHash = Hash(m?.TPAnimHashIdleCrouch?.Name);
        _chargeHash = Hash(m?.TPAnimHashAttackLeftCharge?.Name); _chargeCrouchHash = Hash(m?.TPAnimHashAttackLeftChargeCrouch?.Name);
        _swingHash = Hash(m?.TPAnimHashAttackLeft?.Name); _swingCrouchHash = Hash(m?.TPAnimHashAttackLeftCrouch?.Name);
        _releaseHash = Hash(m?.TPAnimHashAttackLeftRelease?.Name); _releaseCrouchHash = Hash(m?.TPAnimHashAttackLeftReleaseCrouch?.Name);
        _shoveHash = _idle == null ? 0 : Hash(BodyStates.MeleeShove(_idle, false)); _shoveCrouchHash = _idle == null ? 0 : Hash(BodyStates.MeleeShove(_idle, true));
        _equipHash = _idle == null ? 0 : Hash(BodyStates.MeleeEquip(_idle));
    }

    /// <summary>One frame of the recorder's own player: the layers' states from the wielded item, the locomotion state and the events noted since the last frame.</summary>
    internal static void Local(int slot, PlayerInventoryBase inventory, int locomotion, uint now)
    {
        _localSlot = slot;
        var wield = (int)inventory.WieldedSlot;
        var equipped = wield != _wield && _wield != -1;
        if (wield != _wield || now - _itemAt >= 250)
        {
            _wield = wield; _itemAt = now;
            var item = inventory.WieldedItem;
            var pointer = item == null ? IntPtr.Zero : item.Pointer;
            if (pointer != _item)
            {
                _item = pointer;
                _family = item == null ? BodyStates.RifleFamily : (int)item.ThirdPersonFullbodyMovement;
                _left = Hash(item?.LeftHandGripAnim); _right = Hash(item?.RightHandGripAnim);
                _melee = item?.TryCast<Gear.MeleeWeaponFirstPerson>() == null ? null : item!.MeleeAnimationData;
                ReadMelee();
            }
        }
        var crouched = locomotion == (int)PlayerLocomotion.PLOC_State.Crouch;
        var idle = _idle;

        if (locomotion == (int)PlayerLocomotion.PLOC_State.Jump) _jumped = true;
        else if (locomotion != (int)PlayerLocomotion.PLOC_State.Fall) _jumped = false;
        var downed = locomotion == (int)PlayerLocomotion.PLOC_State.Downed;
        if (downed && _downAt == 0) _downAt = Math.Max(1, now);
        if (!downed && _downAt != 0) { _downAt = 0; _reviveUntil = now + BodyStates.ReviveMs; }
        var full = downed ? (now - _downAt < BodyStates.DeadMs ? BodyStates.Dead : BodyStates.DeadIdle)
            : now < _reviveUntil ? BodyStates.Revive : BodyStates.FullBodyState(_family, locomotion, _jumped);
        Set(slot, BodyStates.FullBody, full, BodyStates.FullWeight, now, false);
        var (aim, aimWeight) = BodyStates.Aim(_family);
        Set(slot, BodyStates.AimOffset, aim, aimWeight, now, false);

        // The upper body: the latest action until its time is up (0: held until the next one), else the melee weapon's idle or, weightless, the layer's rest.
        var again = false;
        void Act(int state, int holdMs) { if (state == 0) return; _action = state; _actionUntil = holdMs == 0 ? 0 : now + (uint)holdMs; again = true; }
        if (equipped) Act(idle == null ? BodyStates.EquipState(wield) : _equipHash, idle == null ? BodyStates.EquipGunMs : BodyStates.EquipMeleeMs);
        foreach (var (kind, value) in Pending)
            switch (kind)
            {
                case EventKind.Shot: _recoilUntil = now + BodyStates.RecoilMs; break;
                case EventKind.Throw: Act(BodyStates.ThrowState(value), value == 2 ? BodyStates.ThrowMs : 0); break;
                case EventKind.Interact:
                    if (value == 7) { if (idle != null) Act(crouched ? _shoveCrouchHash : _shoveHash, BodyStates.ShoveMs); }
                    else Act(BodyStates.InteractState(value), BodyStates.InteractMs(value));
                    break;
                case EventKind.MeleeCharge when _melee != null:
                    if (value != 0) Act(crouched ? _chargeCrouchHash : _chargeHash, 0);
                    else if (_actionUntil == 0) _action = 0;
                    break;
                case EventKind.Melee when _melee != null:
                    if (value == 0) Act(crouched ? _swingCrouchHash : _swingHash, BodyStates.SwingMs);
                    else if (value == 1) Act(crouched ? _releaseCrouchHash : _releaseHash, BodyStates.ReleaseMs);
                    else if (idle != null) Act(crouched ? _shoveCrouchHash : _shoveHash, BodyStates.ShoveMs);
                    break;
            }
        Pending.Clear();
        if (_actionUntil != 0 && now >= _actionUntil) { _action = 0; _actionUntil = 0; }
        if (_action != 0) Set(slot, BodyStates.UpperBody, _action, BodyStates.FullWeight, now, again);
        else if (_melee != null) Set(slot, BodyStates.UpperBody, crouched ? _idleCrouchHash : _idleHash, BodyStates.FullWeight, now, false);
        else Set(slot, BodyStates.UpperBody, BodyStates.UpperRest, 0, now, false);
        Set(slot, BodyStates.Additive, now < _recoilUntil ? BodyStates.Recoil : BodyStates.Empty, BodyStates.FullWeight, now, false);
        Set(slot, BodyStates.LeftHand, _left != 0 ? _left : BodyStates.Empty, _left != 0 ? BodyStates.FullWeight : 0, now, false);
        Set(slot, BodyStates.RightHand, _right != 0 ? _right : BodyStates.Empty, _right != 0 ? BodyStates.FullWeight : 0, now, false);
    }

    private static void Set(int slot, int layer, int state, int weight, uint now, bool again)
    {
        if (state == 0 || (!again && Last[slot * BodyStates.Layers + layer] == (state, weight))) return;
        Write(slot, layer, state, now, BodyStates.FadeMs, weight);
    }
}
