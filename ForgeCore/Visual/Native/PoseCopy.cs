using System;
using System.Collections.Generic;
using RootMotion.FinalIK;
using UnityEngine;
using NQuaternion = System.Numerics.Quaternion;
using NVector3 = System.Numerics.Vector3;

namespace ForgeVisual;

/// <summary>The model side of a pose copy (<see cref="Models.ReadPoseTarget"/>), read once per model instance from its skinned mesh's
/// bind poses: the model bones in link order, each bone's frame at rest, and the bones as built to go back to.</summary>
public sealed class PoseTarget
{
    private readonly Transform[] _bones;
    private readonly Vector3[] _restPosition;
    private readonly Quaternion[] _restRotation;

    private PoseTarget(Transform root, IReadOnlyList<PoseLink> links, Transform[] bones, bool[] skipped, NQuaternion[] unframe, NVector3 rootRest, float headHeight)
    {
        Root = root;
        Skipped = skipped;
        HeadHeight = headHeight;
        Links = links;
        _bones = bones;
        Unframe = unframe;
        RootRest = rootRest;
        _restPosition = new Vector3[bones.Length];
        _restRotation = new Quaternion[bones.Length];
        for (var i = 0; i < bones.Length; i++) if (bones[i] != null) { _restPosition[i] = bones[i].localPosition; _restRotation[i] = bones[i].localRotation; }
    }

    /// <summary>Per link: left out of the copy because the model lacks its bone (or an optional bone it points at).</summary>
    internal bool[] Skipped { get; }

    /// <summary>The model's root (its size and turn are the copy's frame).</summary>
    public Transform Root { get; }

    /// <summary>The height of the head bone at rest in the root's own units (the model standing on the root's floor); 0 without a head link.
    /// A caller fits a model to a body by the ratio of the body's head height to this.</summary>
    public float HeadHeight { get; }

    public IReadOnlyList<PoseLink> Links { get; }

    internal NQuaternion[] Unframe { get; }

    /// <summary>Link 0's rest position in the root's space.</summary>
    internal NVector3 RootRest { get; }

    /// <summary>The model bone of link <paramref name="link"/>; null for an optional link the model lacks.</summary>
    public Transform Bone(int link) => _bones[link];

    internal Transform[] Bones => _bones;

    /// <summary>The bones as built (the model standing in its rest pose).</summary>
    public void Rest()
    {
        for (var i = 0; i < _bones.Length; i++)
            if (_bones[i] != null && !_bones[i].WasCollected) { _bones[i].localPosition = _restPosition[i]; _bones[i].localRotation = _restRotation[i]; }
    }

    internal static PoseTarget? Read(Transform root, SkinnedMeshRenderer skin, IReadOnlyList<PoseLink> links, string label)
    {
        if (PoseSolver.Validate(links) is { } bad) { Error(label, "the links are wrong: " + bad); return null; }
        var bones = skin.bones;
        var mesh = skin.sharedMesh;
        var binds = mesh != null ? mesh.bindposes : null;
        if (bones == null || binds == null || binds.Length != bones.Length) { Error(label, "the model has no bind poses"); return null; }
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var b = 0; b < bones.Length; b++) if (bones[b] != null) index.TryAdd(bones[b].name, b);
        var toRoot = root.worldToLocalMatrix * skin.transform.localToWorldMatrix;
        var found = new Transform[links.Count];
        var position = new NVector3[links.Count];
        var rotation = new NQuaternion[links.Count];
        var missing = "";
        var absent = new bool[links.Count];
        for (var i = 0; i < links.Count; i++)
        {
            if (!index.TryGetValue(links[i].Model, out var b))
            {
                if (links[i].Optional) absent[i] = true;
                else missing += (missing.Length > 0 ? ", " : "") + links[i].Model;
                continue;
            }
            var rest = toRoot * binds[b].inverse;
            found[i] = bones[b];
            position[i] = BodyConvert.N(rest.GetColumn(3));
            rotation[i] = BodyConvert.N(rest.rotation);
        }
        if (missing.Length > 0) { Error(label, "the model lacks the bones " + missing); return null; }
        var head = 0f;
        for (var i = 0; i < links.Count; i++) if (links[i].Body == BodyBone.Head) head = position[i].Y;
        return new PoseTarget(root, links, found, PoseSolver.Skipped(links, absent), PoseSolver.Unframe(links, position, rotation), position[0], head);
    }

    internal static void Error(string label, string why)
        => Plugin.Logger.ErrorOnce("visual-pose-copy-model-does-not-follow", "ForgeVisual pose copy " + label + ": " + why + "; the model does not follow the body.");
}

/// <summary>
/// A body's humanoid pose copied onto a <see cref="PoseTarget"/> of other proportions (<see cref="Models.CopyPose(Animator, PoseTarget, IReadOnlyList{PoseReach}, string)"/>, or from bones the caller found): the body's bones
/// in link order (by the game's own <c>Animator.GetBoneTransform</c>), each with its fixed correction to the model bone, read once from
/// the body's bind poses. Call <see cref="Apply"/> every frame after the game animated the body: each model bone takes the turn of its
/// body bone and the root its height and sway, scaled by root height over root height, then each <see cref="PoseReach"/> limb bends so
/// its end lands where the body's does (turns alone put a limb of other proportions elsewhere). While bound the body's animator always animates
/// (a body hidden inside a model would otherwise stop); <see cref="Release"/> hands it back as it was. Applying looks nothing up and
/// allocates nothing.
/// </summary>
public sealed class PoseCopy
{
    private readonly Animator? _animator;
    private readonly AnimatorCullingMode _culling;
    private readonly Transform _body;
    private readonly Transform[] _source;
    private readonly Quaternion[] _correction;
    private readonly PoseTarget _target;
    private readonly NVector3 _rootRest;
    private readonly float _ratio;
    private readonly PoseReach[] _reach;
    private readonly int[] _active;

    private PoseCopy(Transform body, Animator? animator, PoseTarget target, Transform[] source, int[] active, Quaternion[] correction, NVector3 rootRest, float ratio, float scale, PoseReach[] reach)
    {
        _active = active;
        _animator = animator;
        _body = body;
        _target = target;
        _source = source;
        _correction = correction;
        _rootRest = rootRest;
        _ratio = ratio;
        _reach = reach;
        Scale = scale;
        if (animator == null) return;
        _culling = animator.cullingMode;
        animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
    }

    /// <summary>The model's size against the body's (root height over root height, in the world).</summary>
    public float Scale { get; }

    /// <summary>This frame's turn from the body to the model (set by <see cref="Apply"/>).</summary>
    public Quaternion Turn { get; private set; } = Quaternion.identity;

    public PoseTarget Target => _target;

    /// <summary>The body bone of link <paramref name="link"/>.</summary>
    public Transform Source(int link) => _source[link];

    internal static PoseCopy? Bind(Animator animator, PoseTarget target, IReadOnlyList<PoseReach> reach, string label)
    {
        if (animator == null || animator.WasCollected || !animator.isHuman) { PoseTarget.Error(label, "the body has no humanoid animator"); return null; }
        var links = target.Links;
        if (PoseSolver.ValidateReach(reach, links.Count) is { } badReach) { PoseTarget.Error(label, badReach); return null; }
        var body = animator.transform;
        var rest = BodyConvert.BindRest(animator, body);
        var source = new Transform[links.Count];
        var pose = new Matrix4x4[links.Count];
        var toward = new NVector3?[links.Count];
        var absent = (bool[])target.Skipped.Clone();
        var missing = "";
        for (var i = 0; i < links.Count; i++)
        {
            if (absent[i] || Resolve(animator, rest, links[i].Body, links[i].BodyAlt, out source[i], out pose[i])) continue;
            if (links[i].Optional) absent[i] = true;
            else missing += (missing.Length > 0 ? ", " : "") + links[i].Body;
        }
        if (missing.Length > 0) { PoseTarget.Error(label, "the body lacks the bones (or their bind poses) " + missing); return null; }
        for (var i = 0; i < links.Count; i++)
            if (links[i].TowardBody is { } t && Resolve(animator, rest, t, links[i].TowardBodyAlt, out _, out var m)) toward[i] = BodyConvert.N(m.GetColumn(3));
        return Create(body, animator, target, source, pose, toward, PoseSolver.Skipped(links, absent), reach, label);
    }

    /// <summary>A copy from body bones the caller resolved itself (<see cref="Models.CopyPose(Transform, IReadOnlyList{Transform}, IReadOnlyList{Matrix4x4}, Animator?, PoseTarget, string)"/>):
    /// one per link, each with its rest pose in <paramref name="body"/>'s frame. No reach, no toward-body bones.</summary>
    internal static PoseCopy? Bind(Transform body, IReadOnlyList<Transform> bones, IReadOnlyList<Matrix4x4> rest, Animator? animator, PoseTarget target, string label)
    {
        var links = target.Links;
        if (bones.Count != links.Count || rest.Count != links.Count) { PoseTarget.Error(label, "the body has " + bones.Count + " bones for the " + links.Count + " links"); return null; }
        var source = new Transform[links.Count];
        var pose = new Matrix4x4[links.Count];
        var absent = (bool[])target.Skipped.Clone();
        for (var i = 0; i < links.Count; i++)
        {
            if (absent[i]) continue;
            if (bones[i] == null || bones[i].WasCollected)
            {
                if (links[i].Optional) { absent[i] = true; continue; }
                PoseTarget.Error(label, "the body has no bone for " + links[i].Model);
                return null;
            }
            source[i] = bones[i];
            pose[i] = rest[i];
        }
        return Create(body, animator, target, source, pose, new NVector3?[links.Count], PoseSolver.Skipped(links, absent), Array.Empty<PoseReach>(), label);
    }

    private static PoseCopy? Create(Transform body, Animator? animator, PoseTarget target, Transform[] source, Matrix4x4[] pose, NVector3?[] toward, bool[] skip, IReadOnlyList<PoseReach> reach, string label)
    {
        var links = target.Links;
        var position = new NVector3[links.Count];
        var rotation = new NQuaternion[links.Count];
        var active = new List<int>(links.Count);
        for (var i = 0; i < links.Count; i++)
        {
            if (skip[i]) continue;
            active.Add(i);
            position[i] = BodyConvert.N(pose[i].GetColumn(3));
            rotation[i] = BodyConvert.N(pose[i].rotation);
        }
        if (PoseSolver.Ratio(target.RootRest.Y, position[0].Y, out var ratio) is { } why) { PoseTarget.Error(label, why); return null; }
        var corrections = PoseSolver.Correct(links, position, rotation, toward, target.Unframe);
        var correction = new Quaternion[links.Count];
        for (var i = 0; i < links.Count; i++) correction[i] = BodyConvert.U(corrections[i]);
        var scale = ratio * target.Root.lossyScale.y / Math.Max(1e-4f, body.lossyScale.y);
        var reaches = new PoseReach[reach.Count];
        for (var i = 0; i < reaches.Length; i++) reaches[i] = reach[i];
        return new PoseCopy(body, animator, target, source, active.ToArray(), correction, position[0], ratio, scale, reaches);
    }

    /// <summary>The body bone <paramref name="first"/> (else <paramref name="second"/>) and its rest in the body's frame.</summary>
    private static bool Resolve(Animator animator, Dictionary<IntPtr, Matrix4x4> rest, BodyBone first, BodyBone? second, out Transform bone, out Matrix4x4 pose)
    {
        var t = animator.GetBoneTransform((HumanBodyBones)(int)first);
        if (t != null && rest.TryGetValue(t.Pointer, out pose)) { bone = t; return true; }
        if (second is { } alt)
        {
            t = animator.GetBoneTransform((HumanBodyBones)(int)alt);
            if (t != null && rest.TryGetValue(t.Pointer, out pose)) { bone = t; return true; }
        }
        bone = null!;
        pose = default;
        return false;
    }

    /// <summary>Every frame, after the game animated the body: the model's root bone at the body's (height and sway scaled) and every
    /// model bone turned as its body bone is. False when the body or the model is gone.</summary>
    public bool Apply()
    {
        var root = _target.Root;
        if (_animator is { WasCollected: true } || _body == null || _body.WasCollected || root == null || root.WasCollected) return false;
        var turn = root.rotation * Quaternion.Inverse(_body.rotation);
        Turn = turn;
        var bones = _target.Bones;
        var hips = BodyConvert.N(_body.InverseTransformPoint(_source[0].position));
        bones[0].position = root.TransformPoint(BodyConvert.U(PoseSolver.Root(_target.RootRest, hips, _rootRest, _ratio)));
        for (var k = 0; k < _active.Length; k++) { var i = _active[k]; bones[i].rotation = turn * _source[i].rotation * _correction[i]; }
        for (var i = 0; i < _reach.Length; i++) Reach(_reach[i], turn, bones);
        return true;
    }

    /// <summary>The limb bent so its end joint sits at the body's, carried over from the anchor (<see cref="PoseReach"/>).</summary>
    private void Reach(PoseReach r, Quaternion turn, Transform[] bones)
    {
        Transform upper = bones[r.Upper], lower = bones[r.Lower], end = bones[r.End];
        var keep = end.rotation;
        var target = bones[r.Anchor].position + turn * (_source[r.End].position - _source[r.Anchor].position) * Scale;
        var bend = turn * (_source[r.Lower].position - _source[r.Upper].position);
        LimbReach.Bend(upper, lower, end, target, bend);
        end.rotation = keep;
    }

    private static readonly List<PoseCopy> Following = new();
    private bool _following;

    // The body's own FinalIK solvers (a player's, driven by the game's PlayerSyncIK), which pose the body after its animation in their own
    // late update, in an order against this library's late update that nothing fixes. A following copy of such a body is applied once every
    // one of them that solves this frame has solved (each solver's OnPostUpdate), so the model takes the solved pose (hands on the grip,
    // spine along the aim) the same way on a real player and on any other body; with none solving it is applied in this library's late update.
    private IK[] _solvers = Array.Empty<IK>();
    private IKSolver.UpdateDelegate? _solved;
    private int _frame = -1, _expected, _done;

    /// <summary>From now on the library applies the copy every frame itself, after the game animated the body, after the joint clips
    /// played on it (<see cref="JointPlayer"/>) and after the body's own IK solved, until <see cref="Release"/>, the body or the model is
    /// gone, or the level ends. For a caller with nothing of its own to do between (a skin on an enemy, a character on a player); a caller
    /// that poses more after the copy calls <see cref="Apply"/> itself.</summary>
    public void Follow()
    {
        if (_following) return;
        _following = true;
        Following.Add(this);
        if (_animator == null) return;
        _solvers = BodySolvers(_animator);
        if (_solvers.Length == 0) return;
        _solved = (IKSolver.UpdateDelegate)(Action)Solved;
        foreach (var ik in _solvers)
        {
            var solver = ik.GetIKSolver();
            var after = solver.OnPostUpdate;
            solver.OnPostUpdate = after == null ? _solved : Il2CppSystem.Delegate.Combine(after, _solved).Cast<IKSolver.UpdateDelegate>();
        }
    }

    // The FinalIK solvers that pose this body: under the model's object (the animator's parent), the player agent it belongs to and that
    // agent's PlayerSyncIK, whose solver root is this body or holds it.
    private static IK[] BodySolvers(Animator animator)
    {
        var body = animator.transform;
        var found = new List<IK>();
        var seen = new HashSet<IntPtr>();
        var agent = animator.GetComponentInParent<Player.PlayerAgent>();
        foreach (var root in new Component?[] { body.parent != null ? body.parent : body, agent, agent != null ? agent.SyncIK : null })
        {
            if (root == null || root.WasCollected) continue;
            foreach (var ik in root.GetComponentsInChildren<IK>(true))
                if (ik != null && seen.Add(ik.Pointer) && ik.GetIKSolver()?.GetRoot() is { } at && (at == body || at.IsChildOf(body) || body.IsChildOf(at)))
                    found.Add(ik);
        }
        return found.ToArray();
    }

    // How many of the body's solvers solve this frame: those whose late update runs and that are set up.
    private void Begin(int frame)
    {
        _frame = frame; _done = 0; _expected = 0;
        foreach (var ik in _solvers)
            if (!ik.WasCollected && ik.isActiveAndEnabled && ik.GetIKSolver().initiated) _expected++;
    }

    // A solver of the body solved: once every one that solves this frame has, the copy is applied (again, should one more solve after).
    private void Solved()
    {
        var frame = ForgeCore.Frame.Count;
        if (frame != _frame) Begin(frame);
        if (++_done < _expected || !_following) return;
        var i = Following.IndexOf(this);
        if (i >= 0) ApplyFollowing(i);
    }

    /// <summary>Every following copy applied (LateUpdate, after the joint clips) unless its body's IK solves this frame (then applied when
    /// it has solved); a copy whose body or model is gone stops following.</summary>
    internal static void TickAll()
    {
        var frame = ForgeCore.Frame.Count;
        for (var i = Following.Count - 1; i >= 0; i--)
        {
            var copy = Following[i];
            if (copy._solvers.Length > 0)
            {
                if (copy._frame != frame) copy.Begin(frame);
                if (copy._expected > 0) continue;
            }
            ApplyFollowing(i);
        }
    }

    private static void ApplyFollowing(int i)
    {
        var copy = Following[i];
        try { if (copy.Apply()) return; }
        catch (Exception error) { Plugin.Logger.ErrorOnce("visual-pose-copy-failed", "ForgeVisual pose copy failed and stopped following: " + error); }
        copy.Unfollow();
        Following.RemoveAt(i);
    }

    internal static void StopAll()
    {
        foreach (var copy in Following) copy.Unfollow();
        Following.Clear();
    }

    // Stops following: the solvers' callback goes (a solver destroyed with its body has nothing to take back).
    private void Unfollow()
    {
        _following = false;
        if (_solved != null)
            foreach (var ik in _solvers)
                if (!ik.WasCollected && ik.GetIKSolver() is { } solver && solver.OnPostUpdate is { } after)
                    solver.OnPostUpdate = Il2CppSystem.Delegate.Remove(after, _solved)?.Cast<IKSolver.UpdateDelegate>();
        _solvers = Array.Empty<IK>();
        _solved = null;
    }

    /// <summary>The copy stops following and the body's animator is back as it was (nothing to give back once the game has destroyed it, as a
    /// level unload does).</summary>
    public void Release()
    {
        if (_following) { Unfollow(); Following.Remove(this); }
        if (_animator != null && !_animator.WasCollected) _animator.cullingMode = _culling;
    }
}

/// <summary>A two-bone limb (upper arm, forearm, hand; thigh, shin, foot) turned so its end joint lands on a point, with the bone math of
/// <see cref="PoseSolver.Elbow"/>. Call it after the animator has posed the body (late update): the animator writes the bones again next frame.</summary>
public static class LimbReach
{
    /// <summary>Turns <paramref name="upper"/> and <paramref name="lower"/> so <paramref name="end"/> sits on <paramref name="target"/>
    /// (or as near as the bones reach), the middle joint bending toward <paramref name="bend"/>. The end joint's own rotation turns with its parents.</summary>
    public static void Bend(Transform upper, Transform lower, Transform end, Vector3 target, Vector3 bend)
    {
        Vector3 a = upper.position, b = lower.position, c = end.position;
        var elbow = BodyConvert.U(PoseSolver.Elbow(BodyConvert.N(a), BodyConvert.N(target), (b - a).magnitude, (c - b).magnitude, BodyConvert.N(bend), out var reached));
        upper.rotation = Quaternion.FromToRotation(b - a, elbow - a) * upper.rotation;
        b = lower.position;
        lower.rotation = Quaternion.FromToRotation(end.position - b, BodyConvert.U(reached) - b) * lower.rotation;
    }
}
