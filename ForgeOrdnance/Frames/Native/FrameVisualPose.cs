using System;
using ForgeVisual;
using UnityEngine;

namespace ForgeOrdnance.Frames;

/// <summary>A worn suit is its pilot's own game body, scaled: every frame after the game animated the pilot's third-person body and put
/// its hands on the held item's grips, each suit bone takes the turn of the matching humanoid bone of that body and the suit's hips its
/// height and sway, scaled by hip height (ForgeVisual's <see cref="PoseCopy"/>, mapped by <see cref="FrameBodyRig.PoseLinks"/>); then
/// both arms bend so each wrist lands where the body's does from its own shoulder at the suit's arm lengths, the left hand on the held
/// item where the body's grips it (<see cref="FrameBodyRig.ArmReach"/>): the suit's arms are not the body's scaled, so copied turns
/// alone leave the hands off the grips. Both tables are the suit model's body model declaration (<see cref="FrameAssets.RequireArt"/>,
/// ForgeVisual <c>ModelHandle.FollowsBodies</c>), so a recording notes whose body the suit follows and a replay copies the same. Whatever the game's body does (walking,
/// running, crouching, jumping, holding and aiming each weapon, reloading, swinging, carrying) the suit does, on every peer, from the
/// game's own replicated animation. The pilot's own item is held as a copy in the suit's right hand, where the game's item sits against the
/// body's hand, scaled the same: the declaration's holding link, which the pose copy places itself (ForgeVisual's <see cref="PoseCopy.Held"/>),
/// so a replay's suit holds it too; its muzzle is where the suit's shots leave from. The local pilot's suit is drawn as its shadow only; it
/// moves and holds the same.</summary>
internal sealed partial class FrameVisual
{
    /// <summary>The gear shader's light colour the suit's lights (<see cref="GlowColour"/>) are set on, on the first-person shell too.</summary>
    internal const string EmissiveColor = "_EmissiveColor";

    private readonly PoseTarget? _pose;
    private PoseCopy? _copy;
    private bool _posed;
    private IntPtr _syncIK;
    private int _wornFrame = -1;

    private string PoseLabel => _unit.Record.Spec.Model;

    /// <summary>The pilot's body copied onto the suit and what the pilot holds mirrored into the suit's hand.</summary>
    private void BindPose(Player.PlayerAgent agent)
    {
        _copy = _pose != null && agent.AnimatorBody != null ? Models.CopyPose(agent.AnimatorBody, _pose, PoseLabel) : null;
        _copy?.Held?.ShadowOnly(_ownHidden);
        _syncIK = agent.SyncIK != null ? agent.SyncIK.Pointer : IntPtr.Zero;
        PoseAfterIK.Ensure();
    }

    /// <summary>The pilot's body just had its hands put on its grips, after this suit already followed it this frame: follow again.</summary>
    internal void HandsSolved(IntPtr syncIK)
    {
        if (syncIK != _syncIK || _wornFrame != Time.frameCount || _pilot == null) return;
        FollowPilot(Time.time);
    }

    /// <summary>After the game moved the players, while worn: the suit takes the pilot's body pose, then the held item its place.</summary>
    private void PoseFromPilot(float now)
    {
        if (_copy == null || _pose == null) return;
        if (!_copy.Apply()) { Unpose(); return; }
        _posed = true;
        // The lean turns the spine after the copy placed the held item: it goes with the hand again.
        if (ChargeLean(now)) _copy.PlaceHeld();
    }

    // The assault charge, for everyone watching this suit (the pilot's own camera is the game's, never this): the upper body leans into the run
    // while it lasts, and a hit on a door or an enemy drives the right shoulder forward once.
    private const float LeanIn = 0.25f, LeanOut = 0.35f, LeanSpine = 9f, LeanChest = 14f, BumpSeconds = 0.4f, BumpPitch = 8f, BumpTurn = 32f;
    private float _lean, _bumpAt = -99f;

    /// <summary>After the pilot's pose was copied: the charge's lean and shoulder bash on the spine and chest; true when it turned them.</summary>
    private bool ChargeLean(float now)
    {
        var record = _unit.Record;
        var charging = record.State == FrameState.Piloted && record.Boosting(now);
        _lean = Mathf.MoveTowards(_lean, charging ? 1f : 0f, Time.deltaTime / (charging ? LeanIn : LeanOut));
        var age = now - _bumpAt;
        var bash = age >= 0f && age < BumpSeconds ? Mathf.Sin(age / BumpSeconds * Mathf.PI) : 0f;
        if (_lean <= 0f && bash <= 0f) return false;
        var spine = _pose!.Bone(SpineLink);
        var chest = _pose.Bone(ChestLink);
        if (spine == null || chest == null) return false;
        var right = _transform.right;
        spine.rotation = Quaternion.AngleAxis(LeanSpine * _lean, right) * spine.rotation;
        chest.rotation = Quaternion.AngleAxis(LeanChest * _lean + BumpPitch * bash, right) * Quaternion.AngleAxis(-BumpTurn * bash, _transform.up) * chest.rotation;
        return true;
    }

    private const int SpineLink = 1, ChestLink = 2;

    /// <summary>The charge's shoulder hit something: the bash and its impact at <paramref name="point"/>.</summary>
    internal void Bash(Vector3 point, Vector3 forward, float now)
    {
        _bumpAt = now;
        FrameFx.Bash(point, forward, SuitGlow);
    }

    /// <summary>The suit stops following its pilot (no pilot, boarding, leaving): its held item goes and its bones go back to rest.</summary>
    private void Unpose()
    {
        _wornFrame = -1;
        _copy?.Held?.Hide();
        if (!_posed) return;
        _posed = false;
        _pose?.Rest();
    }

    /// <summary>The pilot is gone: the copies of what it held (with the pose copy), and the body's animator handed back.</summary>
    private void UnbindPose()
    {
        _copy?.Release();
        _copy = null;
        _syncIK = IntPtr.Zero;
    }

    /// <summary>The held item's muzzle, while the suit shows one.</summary>
    private bool HeldMuzzle(out Vector3 muzzle)
    {
        muzzle = default;
        return _copy?.Held is { } held && held.TryMuzzle(out muzzle);
    }
}
