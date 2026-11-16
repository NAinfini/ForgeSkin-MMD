using System;
using System.Collections.Generic;
using System.Linq;
using Agents;
using Enemies;
using ForgeCore;
using Player;
using UnityEngine;

namespace ForgeReplay;

/// <summary>Puts the recording's people and monsters into the replay level: one puppet per enemy near the camera (held and driven through
/// ForgeCore's <see cref="Puppets"/>) and one stand-in per recorded player (<see cref="StandIn"/>, a body with no player behind it). What they
/// show comes from the recording only: the position and facing between the latest sample and the next, an enemy's walk animation from the speed
/// those samples give and its death from its end event, a player's body from the recorded layer states and parameters. Main thread only.</summary>
internal static class Puppeteer
{
    // Puppets exist only near the camera: 85 enemies at once is more than the GPU of the test machine took (device removed), and an enemy far
    // from every viewer cannot be seen anyway. One is made within SpawnRadius of the followed player and parked beyond DropRadius.
    private const float SpawnRadius = 70f, DropRadius = 100f;
    private const int SpawnsPerFrame = 4;
    private sealed class Foe
    {
        internal EnemyAgent Agent = null!;
        internal EnemyPuppet? Puppet;
        internal Vector3 Smoothed;
        internal ulong DataId;
        internal bool Parked;
        // The custom limbs shown destroyed on this agent (bits as WorldState.LimbsGone).
        internal ulong LimbsShown;
        // The replay's moment the recorded wake-up state was first shown (NotWaking: it is not waking).
        internal uint WakeSeenMs = NotWaking;
    }

    private const uint NotWaking = uint.MaxValue;

    private static readonly Dictionary<int, Foe> Foes = new();
    private static readonly List<int> Remove = new();
    // Enemy types the recording has and this game does not: skipped, not asked of the game again every frame.
    private static readonly HashSet<ulong> MissingTypes = new();
    private static readonly Dictionary<int, StandIn> StandIns = new();
    private static readonly int[] Wielded = { -1, -1, -1, -1 };
    // The line the stand-in holds for Wielded: a gear line, or StandIn.ItemLine for a pack, consumable or carried item.
    private static readonly string[] WieldLine = { "", "", "", "" };
    // The gear slot each player held last that the recording has no line for: noted once, not rebuilt as text every frame.
    private static readonly int[] MissingWield = { -1, -1, -1, -1 };
    // A body that could not be made is tried again for that slot only after this long, not every frame.
    private const float MakeRetrySeconds = 2f;
    private static readonly float[] _retryAt = new float[4];

    internal static int EnemyCount => Foes.Count;
    internal static int ParkedCount { get { var n = 0; foreach (var foe in Foes.Values) if (foe.Parked) n++; return n; } }
    internal static int PlayerCount => StandIns.Count;
    internal static int Retaken { get { var n = 0; foreach (var foe in Foes.Values) n += foe.Puppet?.Retaken ?? 0; return n; } }

    /// <summary>The enemies a puppet exists for (not parked), for the status line.</summary>
    internal static IEnumerable<(int Entity, EnemyAgent Agent)> Visible()
    {
        foreach (var (entity, foe) in Foes) if (!foe.Parked && foe.Puppet != null && foe.Puppet.Held) yield return (entity, foe.Agent);
    }

    /// <summary>The recorded end of an enemy: <paramref name="died"/> says it was killed rather than gone from sight. Its puppet ends here, at
    /// the event: the recorder numbers enemies by the game's enemy slot, so the next enemy in that slot (a wave fills freed slots at once) comes
    /// with the same number, often in the same frame, and a puppet kept until the next placement would be driven to the new enemy's place.</summary>
    internal static void EnemyEnded(int entity, bool died)
    {
        // It never appeared: its recorded life is over, so this is the moment the skip is real (a retry that works takes it out below).
        if (SpawnFailures.Remove(entity, out var failed)) NoteUnshown(entity, failed.Why, failed.Data);
        if (!Foes.TryGetValue(entity, out var foe)) return;
        // A puppet that is not held cannot die (Die does nothing): the enemy would stay standing where it was last put, so it is taken out instead.
        if (died && foe.Puppet is { Held: true } puppet && !foe.Parked && puppet.Die()) Corpses.Add(foe.Agent, ForgeCore.Frame.UnscaledTime);
        else Park(foe, true);
        Foes.Remove(entity);
    }

    private static readonly CorpseBook<EnemyAgent> Corpses = new();
    private static readonly Action<EnemyAgent> HideCorpse = body =>
    {
        if (body == null || body.WasCollected) return;
        // The game's corpse decay (ES_Dead.DecayDelayed) waits 2-6 s through CoroutineManager, not on the agent. A jump
        // hides every corpse before that, and the delay then runs on a body that is off and may already stand for another
        // enemy: Decay.Initialize gets renderers that no longer belong to it and throws (11-10). Take back the decay that
        // has not started; once it has, its own effect is left to finish.
        if (body.Locomotion != null && body.Locomotion.Dead != null && body.Locomotion.Dead.TryCast<ES_Dead>() is { } dead
            && dead.m_decay == null && dead.m_currentDecayCoroutine != null && CoroutineManager.Current != null)
        {
            CoroutineManager.StopCoroutine(dead.m_currentDecayCoroutine);
            dead.m_currentDecayCoroutine = null;
        }
        body.Sound?.Stop();
        body.gameObject.SetActive(false);
    };

    private static EnemyPuppet? Live(int entity) => Foes.TryGetValue(entity, out var foe) && !foe.Parked && foe.Puppet is { Held: true } puppet ? puppet : null;

    /// <summary>A recorded enemy attack: the enemy plays it in the game's own attack state, aimed at the recorded place.</summary>
    internal static void EnemyAttack(int entity, ES_StateEnum state, Vector3 aim, int animation, float seconds)
    {
        if (Live(entity) is { } puppet) puppet.Attack(state, aim, animation, seconds, null);
    }

    // The tentacle's own callback when it is out: a replay has nothing to settle there.
    private static Il2CppSystem.Action? _nothing;

    /// <summary>A recorded tongue or tentacle launch: the puppet's own tentacle (<paramref name="index"/> in the order under the enemy) reaches
    /// out to <paramref name="at"/>, hangs and comes back on the game's own path, timing and look (<c>MovingEnemyTentacleBase.Attack</c> with
    /// a place). Given a place and no player, the game's tentacle settles no damage. False when the enemy has no puppet or no such tentacle.</summary>
    internal static bool EnemyTongue(int entity, int index, Vector3 at)
    {
        if (Live(entity) is not { } puppet) return false;
        try
        {
            var all = puppet.Agent.GetComponentsInChildren<MovingEnemyTentacleBase>(true);
            if (all == null || all.Length == 0) return false;
            all[Math.Clamp(index, 0, all.Length - 1)].Attack(at, _nothing ??= (System.Action)(static () => { }));
            return true;
        }
        catch (Exception error) { Plugin.Logger.ErrorOnce("A puppet enemy could not reach out with its tongue: " + error.Message); return false; }
    }

    internal static void EnemyHit(int entity, ES_HitreactType type, ImpactDirection direction, int animation) => Live(entity)?.Hitreact(type, direction, animation);

    internal static void EnemyScream(int entity, int animation) => Live(entity)?.Scream(animation, 3f);

    /// <summary>A recorded sleeper's heartbeat (EnemyBeat): the puppet plays it (ForgeCore <c>EnemyPuppet.Heartbeat</c>).</summary>
    internal static void EnemyBeat(int entity, float strength, Vector3 sensed) => Live(entity)?.Heartbeat(strength, sensed);

    /// <summary>A recorded scout's feelers going out or back: the scout's puppet shows them (ForgeCore <c>EnemyPuppet.Feelers</c>).</summary>
    internal static void EnemyFeelers(int entity, bool spread) => Live(entity)?.Feelers(spread);

    /// <summary>A recorded custom limb loss while playing: the enemy's puppet shows it destroyed with the game's destroy effect. An enemy
    /// with no puppet now gets the limb at once when its puppet is made (<see cref="SyncEnemies"/> reads <see cref="WorldState.LimbsGone"/>).</summary>
    internal static void EnemyLimb(int entity, ulong limb)
    {
        if (limb > WorldState.MaxLimbId) Plugin.Logger.ErrorOnce("An enemy lost limb " + limb + ", above the limb ids (0 to " + WorldState.MaxLimbId + ") a jump restores: it shows only while playing past it.");
        if (!Foes.TryGetValue(entity, out var foe) || foe.Parked || foe.Puppet is not { Held: true } puppet) return;
        if (!puppet.DestroyLimb((int)Math.Min(limb, int.MaxValue), false)) Skipped.Note("a puppet enemy has no limb to show destroyed", "data block " + foe.DataId + " limb " + limb);
        foe.LimbsShown |= WorldState.LimbBit(limb);
    }

    /// <summary>Where damage limb <paramref name="limb"/> of the enemy's puppet is now; false when the enemy has no puppet or no such limb.</summary>
    internal static bool LimbPoint(int entity, ulong limb, out Vector3 point)
    {
        point = default;
        if (Live(entity) is not { } puppet) return false;
        var limbs = puppet.Agent.Damage.DamageLimbs;
        if (limbs == null || limb >= (ulong)limbs.Length || limbs[(int)limb] is not { } part) return false;
        point = part.transform.position;
        return true;
    }

    // Puts the puppet's destroyed limbs where the recording has them at this moment. Limbs do not grow back: a puppet that shows a limb the
    // recording has not lost yet (a jump back) is dropped and a new agent is made for the enemy on a later frame. Returns false then.
    private static bool MatchLimbs(int entity, Foe foe, ulong lost)
    {
        if (foe.LimbsShown == lost) return true;
        if ((foe.LimbsShown & ~lost) != 0) { Park(foe, true); Foes.Remove(entity); return false; }
        var missing = lost & ~foe.LimbsShown;
        for (var limb = 0; limb <= WorldState.MaxLimbId; limb++)
        {
            var bit = 1UL << limb;
            if ((missing & bit) == 0) continue;
            if (!foe.Puppet!.DestroyLimb(limb, true)) Skipped.Note("a puppet enemy has no limb to show destroyed", "data block " + foe.DataId + " limb " + limb);
            foe.LimbsShown |= bit;
        }
        return true;
    }

    /// <summary>The root of a recorded enemy's live puppet, or null (parked, not made yet or ended): where a model or an effect of the recording is hung.</summary>
    internal static Transform? EnemyRoot(int entity) => Live(entity)?.Agent.transform;

    /// <summary>The agent of an enemy's puppet, or null when it has none.</summary>
    internal static EnemyAgent? EnemyAgent(int entity) => Live(entity)?.Agent;

    /// <summary>The wield state the body of <paramref name="slot"/> was last asked to show (an <see cref="InventorySlot"/> value, -1 before any).</summary>
    internal static int WieldedOf(int slot) => Wielded[slot & 3];

    /// <summary>The stand-in of a recorded player slot, if one exists.</summary>
    internal static StandIn? StandInOf(int slot) => StandIns.TryGetValue(slot & 3, out var body) && body.Held ? body : null;

    /// <summary>The animator of a recorded player's stand-in, for its bones; null while the player has none or it is not shown.</summary>
    internal static Animator? AnimatorOf(int slot) => StandInOf(slot) is { Visible: true } body ? body.Animator : null;

    /// <summary>The body of a recorded player's stand-in, for outlining it and hanging things on it; null when the player has none.</summary>
    internal static GameObject? BodyOf(int slot) => StandInOf(slot)?.Body;

    /// <summary>A jump in time: every enemy's action ends and every puppet's sounds stop (an attack's loop, a scream, a weapon's tail: each
    /// agent's own sound player), so nothing of the moment left goes on in the one landed in.</summary>
    internal static void Jumped()
    {
        try
        {
            Corpses.All(HideCorpse);
            _landed = true;
            foreach (var foe in Foes.Values)
            {
                foe.WakeSeenMs = NotWaking;
                if (foe.Parked || foe.Puppet is not { Held: true } puppet) continue;
                puppet.Settle();
                puppet.Feelers(false, true);
                puppet.Agent.Sound?.Stop();
            }
        }
        catch (Exception error) { Plugin.Logger.ErrorOnce("The puppets' actions and sounds could not be stopped after a jump: " + error.Message); }
    }

    /// <summary>Releases everything held; the level cleanup that follows destroys the agents.</summary>
    internal static void Clear()
    {
        foreach (var foe in Foes.Values) foe.Puppet?.Dispose();
        Corpses.All(HideCorpse);
        foreach (var body in StandIns.Values) body.Dispose();
        StandIns.Clear();
        _landed = false; Array.Clear(_retryAt);
        Foes.Clear(); MissingTypes.Clear(); SpawnRetryAt.Clear(); SpawnFailures.Clear(); Array.Fill(Wielded, -1); Array.Fill(WieldLine, ""); Array.Fill(MissingWield, -1);
    }

    /// <summary>Adds the pointer of every enemy agent the puppeteer holds or parks to <paramref name="into"/>.</summary>
    internal static void CollectEnemies(HashSet<IntPtr> into)
    {
        foreach (var foe in Foes.Values) if (foe.Agent != null && !foe.Agent.WasCollected) into.Add(foe.Agent.Pointer);
    }

    /// <summary>One frame, after the game's animation: <paramref name="rate"/> is the playback speed (0 while paused).</summary>
    internal static void Sync(WorldState state, uint nowMs, int follow, bool eyes, Vector3? view, float rate, float seconds, IReadOnlyList<PlayerEntry> recorded)
    {
        Corpses.Due(ForgeCore.Frame.UnscaledTime, HideCorpse);
        SyncEnemies(state, nowMs, follow, view, rate, seconds);
        SyncPlayers(state, nowMs, follow, eyes, rate, recorded);
        Deployables.Frame(nowMs);
        Deployables.World(state);
    }

    private static void SyncEnemies(WorldState state, uint nowMs, int follow, Vector3? view, float rate, float seconds)
    {
        // Puppets exist around the followed player, or around the camera when it flies free of every player, and only in the dimension
        // that player is in: an enemy recorded in another dimension (an arena) is at the same coordinates but cannot be seen from here.
        var haveFocus = state.Place(follow, nowMs, out var fx, out var fy, out var fz, out _, out _, out _, out _) || view != null;
        var focus = view ?? new Vector3(fx, fy, fz);
        var viewDimension = ReplayExtras.Place(state, follow, out var playerPlace) ? playerPlace.Dimension : 0;
        var spawned = 0;
        Remove.Clear();
        foreach (var (entity, foe) in Foes)
        {
            if (!state.Enemies.TryGetValue(entity, out var info) || info.DataId != foe.DataId || foe.Agent == null || foe.Agent.WasCollected)
            {
                // Gone from the world without an end event passing (a jump took the world away): parked unseen for good.
                Park(foe, true);
                Remove.Add(entity);
                continue;
            }
            if ((int)info.Dimension != viewDimension)
            {
                Park(foe, true);
                Remove.Add(entity);
                continue;
            }
            if (foe.Puppet == null && !foe.Parked) foe.Puppet = Puppets.Enemy(foe.Agent, Plugin.Id); // a spawn that was not alive yet is held on a later frame
            var near = !haveFocus || !state.Place(entity, nowMs, out var ex, out var ey, out var ez, out _, out _, out _, out _) || Vector3.Distance(focus, new Vector3(ex, ey, ez)) <= DropRadius;
            if (!near && !foe.Parked) Park(foe, false);
        }
        foreach (var entity in Remove) { Foes.Remove(entity); }
        foreach (var (entity, info) in state.Enemies)
        {
            if (!state.Shown(entity, nowMs, out var x, out var y, out var z, out var qx, out var qy, out var qz, out var qw)) continue;
            if ((int)info.Dimension != viewDimension) continue;
            var position = new Vector3(x, y, z);
            var rotation = new Quaternion(qx, qy, qz, qw);
            if (!Foes.TryGetValue(entity, out var foe))
            {
                if (haveFocus && Vector3.Distance(focus, position) > SpawnRadius || spawned >= SpawnsPerFrame) continue;
                if (MissingTypes.Contains(info.DataId)) continue;
                if (GameData.EnemyDataBlock.GetBlock((uint)info.DataId) == null)
                {
                    MissingTypes.Add(info.DataId);
                    Skipped.Note("an enemy type this game does not have", "enemy data block " + info.DataId);
                    continue;
                }
                // An enemy that cannot be made now (no node under it, the game refused) waits before it is tried again, and never eats the frame's budget.
                if (SpawnRetryAt.TryGetValue(entity, out var retryAt) && ForgeCore.Frame.UnscaledTime < retryAt) continue;
                if (!ForgeCore.Level.HasDimension((int)info.Dimension) || !ForgeCore.Level.CourseNodeIn((int)info.Dimension, position, 2f, out var node) || node == null)
                { SpawnFailed(entity, "no place to stand in its dimension", info.DataId); continue; }
                var agent = EnemyAllocator.Current.SpawnEnemy((uint)info.DataId, node, AgentMode.Hibernate, position, rotation, null, -1);
                if (agent == null) { SpawnFailed(entity, "the game made nothing", info.DataId); continue; }
                spawned++;
                SpawnRetryAt.Remove(entity); SpawnFailures.Remove(entity);
                foe = new Foe { Agent = agent, DataId = info.DataId };
                Foes[entity] = foe;
                foe.Puppet = Puppets.Enemy(agent, Plugin.Id);
            }
            else if (foe.Parked)
            {
                if (haveFocus && Vector3.Distance(focus, position) > SpawnRadius) continue;
                foe.Agent.gameObject.SetActive(true);
                foe.Parked = false;
                foe.Puppet ??= Puppets.Enemy(foe.Agent, Plugin.Id);
            }
            if (foe.Puppet == null || !foe.Puppet.Held) continue;
            if (!MatchLimbs(entity, foe, state.LimbsGone[entity])) continue;
            foe.Puppet.Rate = rate;
            // 0: no state recorded yet, the enemy walks.
            var pose = (ES_StateEnum)state.EnemyLocomotion[entity];
            if (pose != 0)
            {
                var variant = entity; var turn = false;
                if (pose == ES_StateEnum.HibernateWakeUp && ReplayExtras.WakeUp(state, entity, out var wake))
                {
                    // The game keeps the sleeping pose for the wake-up's delay, then plays the animation it picked (ES_HibernateWakeUp.DoWakeup).
                    if (foe.WakeSeenMs == NotWaking) foe.WakeSeenMs = nowMs;
                    if (nowMs < foe.WakeSeenMs + wake.DelayMs) pose = ES_StateEnum.Hibernate;
                    variant = wake.Index; turn = wake.Turn;
                }
                else foe.WakeSeenMs = NotWaking;
                foe.Puppet.Stance(pose, variant, turn);
            }
            // A sleeper sensing someone (the light sleep): the game's own detection start and end on the puppet.
            if (ReplayExtras.Mind(state, entity, out var mind)) foe.Puppet.Detecting(mind.Detecting);
            var velocity = Recorded.Velocity(state, entity, nowMs);
            foe.Smoothed = Vector3.Lerp(foe.Smoothed, velocity, 1f - Mathf.Exp(-seconds / 0.12f)); velocity = foe.Smoothed;
            foe.Puppet.Drive(position, rotation, velocity);
        }
    }

    private const float SpawnRetrySeconds = 2f;
    private static readonly Dictionary<int, float> SpawnRetryAt = new();
    // Enemies whose spawn was refused and which are retried: reported only when their recorded life ends without their ever being shown,
    // so a refusal the next try makes good (a spawn the game was not ready for, or several in one frame) is not called a skip.
    private static readonly Dictionary<int, (string Why, ulong Data)> SpawnFailures = new();

    private static void SpawnFailed(int entity, string why, ulong dataId)
    {
        SpawnFailures[entity] = (why, dataId);
        SpawnRetryAt[entity] = ForgeCore.Frame.UnscaledTime + SpawnRetrySeconds;
    }

    private static void NoteUnshown(int entity, string why, ulong dataId)
        => Skipped.Note("a recorded enemy could not be shown: " + why, "enemy data block " + dataId + " (entity " + entity + ")");

    /// <summary>The replay ended: an enemy still in the recording that was never shown is reported now, and the retries stop.</summary>
    internal static void ReportUnshown()
    {
        foreach (var (entity, failed) in SpawnFailures) NoteUnshown(entity, failed.Why, failed.Data);
        SpawnFailures.Clear(); SpawnRetryAt.Clear();
    }

    // Out of sight: the agent is hidden and keeps its puppet, so it costs nothing and comes back as it was. A removal (a jump, an enemy that is
    // no longer in the recording) takes it out of the level through the game's own despawn: a hidden agent stays in the culling system's
    // nodes and lights, where its shadow could still be drawn.
    private static void Park(Foe foe, bool forever)
    {
        if (foe.Agent == null || foe.Agent.WasCollected) return;
        foe.Puppet?.Feelers(false, true);
        foe.Parked = true;
        foe.Agent.gameObject.SetActive(false);
        if (!forever) return;
        foe.Puppet?.Dispose();
        try { if (foe.Agent.Alive) foe.Agent.Sync?.Replicator?.Despawn(); }
        catch (Exception error) { Plugin.Logger.ErrorOnce("A puppet enemy could not be taken out of the level: " + error.Message); }
    }

    // Every recorded player is a stand-in: a body made from the game's player rig as the game makes every player's (any player agent gives the rig;
    // the replay level has only the observer's), made when the player first counts and kept for the whole replay. What it plays is the recording's and nothing else: the place and look between two samples,
    // the body controller's layer states (PlayerAnimLayer) and parameters (PlayerMotion), the wielded gear, the flashlight. Its one switch says
    // whether it shows: the player is in the game at this moment, and the camera does not sit in its head.
    private static void SyncPlayers(WorldState state, uint nowMs, int follow, bool eyes, float rate, IReadOnlyList<PlayerEntry> recorded)
    {
        var jumped = _landed; _landed = false;
        var seconds = ForgeCore.Frame.UnscaledDeltaTime;
        for (var slot = 0; slot < 4; slot++)
        {
            if (!ReplayFeed.EverHeld(slot, recorded, Recorded.Lines)) continue;
            if (!StandIns.TryGetValue(slot, out var body))
            {
                if (Players.Local is not { } player) continue;
                if (ForgeCore.Frame.UnscaledTime < _retryAt[slot]) continue;
                var made = StandIn.Make(player, Skipped.Note, out var why);
                if (made == null)
                {
                    Plugin.Logger.ErrorOnce("The body of a recorded player could not be made: " + why);
                    _retryAt[slot] = ForgeCore.Frame.UnscaledTime + MakeRetrySeconds;
                    continue;
                }
                StandIns[slot] = body = made;
            }
            if (!body.Held) continue;
            var x = 0f; var y = 0f; var z = 0f; var qx = 0f; var qy = 0f; var qz = 0f; var qw = 1f;
            var here = Recorded.Holder(slot).Filled && state.Poses[slot].Present && state.Shown(slot, nowMs, out x, out y, out z, out qx, out qy, out qz, out qw);
            body.Visible = here && !(eyes && slot == (follow & 3));
            if (!body.Visible) continue;
            // The clothes and the look (a character model) the player had at this moment, on the slot's character (the game seats character N in
            // slot N); a look no provider here can wear leaves the clothes.
            var loadout = Recorded.Holder(slot).Loadout;
            body.Dress(slot, Recorded.OutfitOf(loadout), Recorded.LookOf(loadout));
            NoteWield(slot, state);
            if (Wielded[slot] > 0) body.Hold(Wielded[slot], WieldLine[slot]);
            body.Lamp(state.PlayerKits[slot] is { Known: true, Flashlight: true });
            foreach (var layer in BodyStates.Recorded)
                if (ReplayExtras.AnimLayer(state, slot, layer, out var played))
                    body.Play(layer, played.State, played.StartMs, nowMs, played.FadeMs / 1000f, played.Weight / (float)BodyStates.FullWeight, jumped, rate > 0f ? seconds : 0f);
            body.Pose(new Vector3(x, y, z), new Quaternion(qx, qy, qz, qw) * Vec.Forward, state.PlayerForward[slot], state.PlayerRight[slot], state.PlayerCrouch[slot], state.PlayerAimPitch[slot], rate, seconds, jumped);
        }
    }

    // A jump landed since the last frame: every stand-in enters its states at once, at the time they have reached.
    private static bool _landed;

    /// <summary>The bodies in the scene, for ReplayControl.Inspect: what the puppeteer holds against what is active.</summary>
    internal static string Inspect()
    {
        var text = new System.Text.StringBuilder();
        var alive = 0; var types = new Dictionary<uint, int>();
        foreach (var agent in UnityEngine.Object.FindObjectsOfType<EnemyAgent>())
        {
            if (agent == null) continue;
            alive++; types[agent.EnemyDataID] = types.GetValueOrDefault(agent.EnemyDataID) + 1;
        }
        text.Append("foes ").Append(Foes.Count).Append(" parked ").Append(ParkedCount).Append(" corpses ").Append(Corpses.Count).Append(" active agents ").Append(alive).Append(" by type ").Append(string.Join(",", types.Select(p => p.Key + ":" + p.Value)));
        foreach (var (entity, foe) in Foes) if (foe.DataId is 29 or 36 && foe.Agent != null) text.Append("\nbig ").Append(entity).Append(" type ").Append(foe.DataId).Append(" parked ").Append(foe.Parked).Append(" at ").Append(foe.Agent.Position);
        foreach (var (slot, body) in StandIns)
        {
            text.Append("\nslot ").Append(slot).Append(' ').Append(Recorded.Holder(slot).Name).Append(" stand-in held ").Append(body.Held).Append(" visible ").Append(body.Visible).Append(" holds ").Append(body.HeldName);
            if (!body.Held || !body.Visible) continue;
            text.Append(' ').Append(body.Describe());
            foreach (var layer in BodyStates.Recorded)
            {
                var hash = body.Animator.GetCurrentAnimatorStateInfo(layer).shortNameHash;
                text.Append(" L").Append(layer).Append('=').Append(BodyStates.Name(hash) ?? hash.ToString());
            }
        }
        return text.ToString();
    }

    // What the body has in its hands for a PlayerStatus: the gear the recording says, or the pack, consumable or carried item of that slot in the
    // recorded kit (made as the game makes another player's held item: StandIn.ItemLine). A wield with nothing the recording can show keeps the
    // last gear (a level item carried in the hands is shown by Carried, which puts the body's own away for as long).
    private static void NoteWield(int slot, WorldState state)
    {
        if (state.PlayerStatus[slot] is not { } status) return;
        var read = PayloadReader.Over(status);
        read.U(); read.U();
        var wield = (InventorySlot)read.U();
        var loadout = Recorded.Holder(slot).Loadout;
        var gear = IsGear((int)wield);
        // A gear slot the recording has no line for (a client recorder reads another player's gear only as it syncs) cannot be shown.
        if (gear && Recorded.GearLineOf(loadout, (int)wield).Length == 0)
        {
            if (MissingWield[slot] != (int)wield)
            {
                MissingWield[slot] = (int)wield;
                Skipped.Note("a player's gear in the hands is not in the recording; the last known gear is shown", "player " + (slot + 1) + " slot " + wield);
            }
            gear = false;
        }
        ref readonly var kit = ref state.PlayerKits[slot];
        var item = !kit.Known ? 0u : wield switch
        {
            InventorySlot.ResourcePack => kit.PackItem,
            InventorySlot.Consumable => kit.ConsumableItem,
            InventorySlot.InLevelCarry => kit.CarryItem,
            _ => 0u,
        };
        if (gear) { Wielded[slot] = (int)wield; WieldLine[slot] = Recorded.GearLineOf(loadout, (int)wield); }
        else if (item != 0) { Wielded[slot] = (int)wield; WieldLine[slot] = StandIn.ItemLine(item); }
        else if (Wielded[slot] <= 0 || !IsGear(Wielded[slot]))
        {
            Wielded[slot] = FirstKnownGear(slot);
            WieldLine[slot] = Recorded.GearLineOf(loadout, Wielded[slot]);
        }
    }

    private static bool IsGear(int wield) => (InventorySlot)wield is InventorySlot.GearStandard or InventorySlot.GearSpecial or InventorySlot.GearClass or InventorySlot.GearMelee;

    // The first gear slot the recording has a line for, or the standard slot.
    private static int FirstKnownGear(int slot)
    {
        foreach (var gear in Recorded.GearSlots) if (Recorded.GearLineOf(Recorded.Holder(slot).Loadout, (int)gear).Length > 0) return (int)gear;
        return (int)InventorySlot.GearStandard;
    }

}
