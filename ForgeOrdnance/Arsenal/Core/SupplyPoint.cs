using System;
using System.Collections.Generic;

namespace ForgeOrdnance.Arsenal;

/// <summary>How a placed heavy weapon keeps supplying (a placement's <c>Overrides</c>, DEVELOPERS.md "Supply points"): <see cref="Supply"/>
/// weapons in all (0 is no limit), each rack laid again <see cref="Restock"/> seconds after it was taken. A placement that writes neither
/// <c>Supply</c> nor <c>Restock</c> is no supply point: its racks are taken once, as before.</summary>
internal sealed record SupplyRule(int Supply, float Restock)
{
    internal const string SupplyField = "Supply", RestockField = "Restock";
    internal const int SupplyMax = 10000;
    internal const double RestockMax = 3600;
    /// <summary>The wait when a placement writes <c>Supply</c> but no <c>Restock</c>.</summary>
    internal const float DefaultRestock = 3f;

    /// <summary>The rule a placement's overrides give, or null when they make no supply point.</summary>
    internal static SupplyRule? From(IReadOnlyDictionary<string, double> overrides)
    {
        var hasSupply = overrides.TryGetValue(SupplyField, out var supply);
        var hasRestock = overrides.TryGetValue(RestockField, out var restock);
        if (!hasSupply && !hasRestock) return null;
        return new SupplyRule(hasSupply ? (int)supply : 0, hasRestock ? (float)restock : DefaultRestock);
    }
}

/// <summary>
/// The host's book of one supply point: which of its racks lie there to take, which wait for their restock and when, and how many weapons
/// it has laid out. A weapon counts when it is laid (the first racks, and each restock when its wait starts), so two racks waiting never
/// lay more than <see cref="SupplyRule.Supply"/> between them. The racks lying at once are never more than the placement's count.
/// </summary>
internal sealed class SupplyPoint
{
    private enum Bay : byte { Empty, Stocked, Waiting }

    private readonly Bay[] _bays;
    private readonly float[] _due;

    internal SupplyPoint(SupplyRule rule, int racks)
    {
        Rule = rule;
        _bays = new Bay[Math.Max(1, racks)];
        _due = new float[_bays.Length];
    }

    internal SupplyRule Rule { get; }
    /// <summary>Weapons laid out so far (racks lying, taken, or waiting to be laid).</summary>
    internal int Given { get; private set; }
    internal int Racks => _bays.Length;
    /// <summary>True when nothing lies there, nothing waits and no weapon is left to lay: the point is done.</summary>
    internal bool Spent
    {
        get
        {
            foreach (var bay in _bays) if (bay != Bay.Empty) return false;
            return !CanGive;
        }
    }

    private bool CanGive => Rule.Supply == 0 || Given < Rule.Supply;

    internal bool IsStocked(int bay) => _bays[bay] == Bay.Stocked;

    /// <summary>The first racks: each bay is laid while weapons are left. Returns the bays laid.</summary>
    internal List<int> Start()
    {
        var laid = new List<int>(_bays.Length);
        for (var bay = 0; bay < _bays.Length; bay++)
        {
            if (!CanGive) break;
            Given++;
            _bays[bay] = Bay.Stocked;
            laid.Add(bay);
        }
        return laid;
    }

    /// <summary>The rack of <paramref name="bay"/> was taken at <paramref name="now"/>: it is laid again after the restock wait while weapons are left.</summary>
    internal void Taken(int bay, float now)
    {
        if ((uint)bay >= (uint)_bays.Length || _bays[bay] != Bay.Stocked) return;
        if (!CanGive) { _bays[bay] = Bay.Empty; return; }
        Given++;
        _bays[bay] = Bay.Waiting;
        _due[bay] = now + Rule.Restock;
    }

    /// <summary>The bays whose wait is over at <paramref name="now"/>; each is stocked again. <paramref name="ready"/> is cleared first.</summary>
    internal void Due(float now, List<int> ready)
    {
        ready.Clear();
        for (var bay = 0; bay < _bays.Length; bay++)
        {
            if (_bays[bay] != Bay.Waiting || now < _due[bay]) continue;
            _bays[bay] = Bay.Stocked;
            ready.Add(bay);
        }
    }

    /// <summary>The point as it stands at <paramref name="now"/>, for a checkpoint: a wait keeps the seconds it had left.</summary>
    internal SupplySnapshot Capture(float now)
    {
        var left = new float[_bays.Length];
        var bays = new byte[_bays.Length];
        for (var bay = 0; bay < _bays.Length; bay++)
        {
            bays[bay] = (byte)_bays[bay];
            left[bay] = _bays[bay] == Bay.Waiting ? Math.Max(0f, _due[bay] - now) : 0f;
        }
        return new SupplySnapshot(Given, bays, left);
    }

    /// <summary>The point as a checkpoint saved it, at <paramref name="now"/>: the same racks lie there, the same waits have the same
    /// seconds left, the same count is laid out. Returns the bays to lay now; false when the snapshot does not fit this point.</summary>
    internal bool Restore(SupplySnapshot saved, float now, out List<int> laid)
    {
        laid = new List<int>(_bays.Length);
        if (saved.Bays.Length != _bays.Length || saved.Left.Length != _bays.Length || saved.Given < 0) return false;
        Given = saved.Given;
        for (var bay = 0; bay < _bays.Length; bay++)
        {
            _bays[bay] = (Bay)saved.Bays[bay];
            _due[bay] = now + saved.Left[bay];
            if (_bays[bay] == Bay.Stocked) laid.Add(bay);
        }
        return true;
    }

    /// <summary>A host that took over the point (the old host's book is gone): the racks still lying are <paramref name="lying"/>, the
    /// weapons laid out so far as this peer counted them are <paramref name="given"/>; every other bay waits a full restock while weapons are left.</summary>
    internal void Adopt(bool[] lying, int given, float now)
    {
        Given = given;
        for (var bay = 0; bay < _bays.Length; bay++)
        {
            if (bay < lying.Length && lying[bay]) { _bays[bay] = Bay.Stocked; continue; }
            if (!CanGive) { _bays[bay] = Bay.Empty; continue; }
            Given++;
            _bays[bay] = Bay.Waiting;
            _due[bay] = now + Rule.Restock;
        }
    }
}

/// <summary>A supply point at a checkpoint (<see cref="SupplyPoint.Capture"/>); kept by the host only.</summary>
internal sealed record SupplySnapshot(int Given, byte[] Bays, float[] Left);
