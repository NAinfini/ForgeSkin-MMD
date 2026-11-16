using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using ForgeCore;
using SNetwork;

namespace ForgeReplay;

/// <summary>One level's recording: the header captured when the level is built, and the file it opens.</summary>
internal static class Session
{
    internal static ReplayHeader? Header { get; private set; }
    internal static string? FilePath { get; private set; }
    /// <summary>How the level ended, from the game's expedition state; Left unless the game said success or failure.</summary>
    internal static Outcome Outcome { get; private set; } = Outcome.Left;
    private static FileStream? _stream;
    private static ChunkWriter? _writer;

    private static List<PluginEntry>? _plugins;

    private static System.Threading.Tasks.Task<List<PluginEntry>>? _pluginsTask;

    /// <summary>Starts hashing the loaded plugins' DLLs on a worker thread once every plugin has loaded (the files are read, so not on the game's frame, where
    /// the first level's header would otherwise wait for them).</summary>
    internal static void PreparePlugins() => _pluginsTask ??= System.Threading.Tasks.Task.Run(() =>
    {
        var list = new List<PluginEntry>();
        foreach (var p in InstalledPlugins.List()) list.Add(new PluginEntry(p.Guid, p.Version, p.DllHash));
        return list;
    });

    /// <summary>The plugins this game loaded, as a header records them; read once (they do not change while the game runs).</summary>
    internal static IReadOnlyList<PluginEntry> PluginsHere()
    {
        if (_plugins != null) return _plugins;
        try { PreparePlugins(); return _plugins = _pluginsTask!.Result; }
        catch (Exception error) { Plugin.Logger.Error("Listing the installed plugins failed: " + error.Message); return _plugins = new List<PluginEntry>(); }
    }

    private static System.Threading.Tasks.Task<List<ContentEntry>>? _content;

    /// <summary>Starts reading the installed packages' content on a worker thread (the files are read, so not on the game's frame); the
    /// game has loaded far longer before a header or the list asks for it.</summary>
    internal static void PrepareContent() => _content ??= System.Threading.Tasks.Task.Run(() =>
    {
        var list = new List<ContentEntry>();
        foreach (var p in InstalledPlugins.ContentPrints()) list.Add(new ContentEntry(p.Package, p.Hash));
        return list;
    });

    /// <summary>The content the installed packages ship, as a header records it.</summary>
    internal static IReadOnlyList<ContentEntry> ContentHere()
    {
        PrepareContent();
        try { return _content!.Result; }
        catch (Exception error) { Plugin.Logger.Error("Fingerprinting the installed content failed: " + error.Message); return new List<ContentEntry>(); }
    }

    private static IEnumerator<string>? _header;

    /// <summary>The level was built: the header is made in steps, one on each following frame (<see cref="HeaderTick"/>), because fingerprinting the level
    /// is a handful of whole-scene scans that, done at once, stop the elevator for most of a second. The level and its seeds are read now.</summary>
    internal static void BuildDone()
    {
        _header = null;
        try
        {
            if (!Level.TryCurrentLevel(out var level, out var seeds)) throw new InvalidOperationException("The game cannot say which level was built.");
            _header = HeaderSteps(level, seeds).GetEnumerator();
        }
        catch (Exception error) { Plugin.Logger.Error("Recording the level header failed: " + error); }
    }

    /// <summary>Every frame: one more step of the level's header, until the recording is open.</summary>
    internal static void HeaderTick()
    {
        if (_header == null) return;
        try { if (!_header.MoveNext()) _header = null; }
        catch (Exception error) { _header = null; Plugin.Logger.Error("Recording the level header failed: " + error); }
    }

    private static IEnumerable<string> HeaderSteps(LevelId level, LevelSeeds seeds)
    {
        GenerationFingerprint? generation = null;
        foreach (var step in Level.FingerprintSteps(found => generation = found)) yield return step;
        if (generation == null) throw new InvalidOperationException("The level has no built floor to fingerprint.");
        var header = new ReplayHeader
        {
            ReplayVersion = Plugin.Version,
            GameRevision = CellBuildData.GetRevision(),
            RundownId = level.RundownId,
            Tier = level.Tier,
            Index = level.Index,
            RundownName = RundownNames.Loaded(level.RundownId) ?? "",
            BuildSeed = seeds.BuildSeed,
            HostIdSeed = seeds.HostIdSeed,
            SessionSeed = seeds.SessionSeed,
            GenerationHash = generation.Whole,
            RecorderName = SNet.LocalPlayer?.NickName ?? "",
            RecorderIsHost = ForgeCore.Session.IsHost,
            // A client building the level of a session already in play is dropping in: the recording starts at its join.
            Start = !ForgeCore.Session.IsHost && SNet.IsInDropin ? StartMode.MidJoin : StartMode.Launch,
        };
        header.Plugins.AddRange(PluginsHere());
        header.Content.AddRange(ContentHere());
        foreach (var (name, hash) in generation.Sections) header.GenerationSections.Add(new NamedHash(name, hash));
        // The four character slots, people and bots alike: whether the lobby list holds the bots is not something to rely on.
        for (var slot = 0; slot < 4; slot++)
            if (SNet.Slots.GetPlayerInSlot(slot) is { } player)
            {
                header.Players.Add(new PlayerEntry(slot, player.NickName, Loadout(player)));
                if (player.IsLocal && !player.IsBot) header.RecorderSlot = slot;
            }
        Header = header;
        yield return "header";
        Open(level, header);
    }
    private static readonly Player.InventorySlot[] LoadoutSlots = { Player.InventorySlot.GearStandard, Player.InventorySlot.GearSpecial, Player.InventorySlot.GearMelee, Player.InventorySlot.GearClass };

    /// <summary>The gear of the four weapon and tool slots, as the game's own gear JSON one slot per line (an empty line for an empty slot),
    /// so a replay can rebuild what each player carried; a slot whose backpack entry names no gear yet reads it from the item made from it.
    /// A fifth line is the outfit (<see cref="Outfit"/>), a sixth the look (<see cref="Look"/>). Also written by the Presence event of a player who
    /// joins, and again (Presence) whenever it differs from what the file last said.</summary>
    internal static string Loadout(SNet_Player player)
    {
        if (!Player.PlayerBackpackManager.TryGetBackpack(player, out var backpack)) return "";
        var lines = new string[LoadoutSlots.Length + 2];
        for (var i = 0; i < LoadoutSlots.Length; i++) lines[i] = GearAt(backpack, LoadoutSlots[i]) is { } gear ? gear.ToJSON().Replace("\n", " ") : "";
        lines[LoadoutSlots.Length] = Outfit(backpack);
        lines[LoadoutSlots.Length + 1] = Look(player);
        return string.Join("\n", lines);
    }

    /// <summary>What ForgeCore's player look provider (a character-model mod, if one is installed) says the player looks like: its id and the
    /// description in base64, space separated; "" when the game's own body shows. ForgeReplay knows no provider.</summary>
    private static string Look(SNet_Player player)
        => ForgeVisual.PlayerLooks.Describe(player) is { } look ? look.ProviderId + " " + Convert.ToBase64String(look.Data) : "";

    // Bumped whenever the look provider says a player looks different, so the next LoadoutKey moves and the loadout is written again.
    private static long _looksChanged;
    private static bool _watchingLooks;

    // The game's clothes slots in the order the outfit line keeps them.
    private static readonly ClothesType[] OutfitSlots = { ClothesType.Helmet, ClothesType.Torso, ClothesType.Legs, ClothesType.Backpack, ClothesType.Palette };

    /// <summary>The outfit the player wears: the vanity item ID (<c>VanityItemsTemplateDataBlock</c>) of the helmet, torso, legs, backpack and
    /// palette, space separated, 0 for the character's default. Read from the backpack, which the game keeps synced for every player
    /// (<c>pInventorySync</c>), so a client records the others' clothes as they are, not its own guess.</summary>
    private static string Outfit(Player.PlayerBackpack backpack)
    {
        var ids = new string[OutfitSlots.Length];
        for (var i = 0; i < ids.Length; i++) ids[i] = backpack.GetBackpackVanityItem(OutfitSlots[i]).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return string.Join(" ", ids);
    }

    /// <summary>A number that changes when the gear of any of <see cref="Loadout"/>'s slots or the outfit does: the game's own checksum of each slot's
    /// <c>GearIDRange</c> and the vanity item IDs folded together, plus a count of the look provider's changes (<c>PlayerLooks.Changed</c>), read without making any JSON. -1 when the player has no backpack. Equal keys mean an equal loadout,
    /// so the recorder builds the JSON only when the key moved.</summary>
    internal static long LoadoutKey(SNet_Player player)
    {
        if (!Player.PlayerBackpackManager.TryGetBackpack(player, out var backpack)) return -1;
        if (!_watchingLooks) { _watchingLooks = true; ForgeVisual.PlayerLooks.Changed += _ => _looksChanged++; }
        long key = 17 + _looksChanged;
        foreach (var slot in LoadoutSlots) key = key * 1000003 + (GearAt(backpack, slot) is { } gear ? gear.GetChecksum() + 1L : 0L);
        foreach (var clothes in OutfitSlots) key = key * 1000003 + backpack.GetBackpackVanityItem(clothes);
        return key & long.MaxValue;
    }

    private static global::Gear.GearIDRange? GearAt(Player.PlayerBackpack backpack, Player.InventorySlot slot)
        => backpack.TryGetBackpackItem(slot, out var item) && item != null ? item.GearIDRange ?? item.Instance?.TryCast<ItemEquippable>()?.GearIDRange : null;

    private static void Open(LevelId level, ReplayHeader header)
    {
        Close();
        // A replay is not recorded again: the level is the replay level while one is chosen or playing.
        if (!Plugin.RecordingEnabled.Value || Replayer.Pending != null) return;
        Directory.CreateDirectory(Plugin.ReplayFolder);
        Outcome = Outcome.Left;
        FilePath = Path.Combine(Plugin.ReplayFolder, DateTime.Now.ToString("yyyyMMdd-HHmmss") + "_" + level.Coordinate + ".frpl");
        _stream = new FileStream(FilePath, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        _writer = ChunkLog.Create(_stream, ReplayHeader.FormatVersion);
        _writer.Append(ChunkTypes.Header, 0, 0, header.Encode());
        PlayerRecorder.Start(_writer);
    }

    internal static void StateChanged(eGameStateName from, eGameStateName to)
    {
        if (to == eGameStateName.ExpeditionSuccess) Outcome = Outcome.Success;
        else if (to == eGameStateName.ExpeditionFail) Outcome = Outcome.Failed;
        if (!Load.Loading) return;
        if (to == eGameStateName.Generating) Load.BuildStarted(LoadClock.Elapsed.TotalMilliseconds);
        else if (to == eGameStateName.InLevel) WriteLoad(Load.Entered(LoadClock.Elapsed.TotalMilliseconds));
    }

    // Replay loading in stages, to tell a slow load from a stuck or failed one: play chosen (Replayer.Pending set), the game starts building the
    // level (Generating), the level is entered (InLevel). A load that is quick and ends in the level writes nothing (LoadWatch decides the rest).
    private static readonly Stopwatch LoadClock = new();
    private static readonly LoadWatch Load = new();
    private static bool _pending;

    /// <summary>Every frame: starts the load clock when a replay is chosen, reports a load that runs past the limit, and reports a load that
    /// ends (the chosen replay is dropped, as the level cleanup does) without the level having been entered.</summary>
    internal static void WatchReplayLoad()
    {
        var pending = Replayer.Pending != null;
        if (pending != _pending)
        {
            _pending = pending;
            if (pending) { LoadClock.Restart(); Load.Start(); }
            else { WriteLoad(Load.Failed(LoadClock.Elapsed.TotalMilliseconds)); LoadClock.Reset(); }
        }
        if (Load.Loading) WriteLoad(Load.Tick(LoadClock.Elapsed.TotalMilliseconds));
    }

    private static void WriteLoad(LoadReport? report)
    {
        if (report is not { } r) return;
        // A long build is what a large level takes (65 s in the 11-05 run), not an error; only a load that never got to the build or never ended in the level is.
        if (r.Kind == LoadReportKind.EnteredSlow || r.Kind == LoadReportKind.StillLoading && r.BuildingAtMs >= 0) return;
        var splits = Log.Num(r.TotalMs / 1000) + " s since play was chosen, "
            + (r.BuildingAtMs < 0 ? "the build never started" : Log.Num(r.BuildingAtMs / 1000) + " s until the build started, " + Log.Num((r.TotalMs - r.BuildingAtMs) / 1000) + " s building");
        var what = r.Kind switch
        {
            LoadReportKind.StillLoading => "The replay level is still being built: ",
            LoadReportKind.EnteredSlow => "Loading the replay level was slow, the level was entered: ",
            _ => "Loading the replay level ended without the level being entered: ",
        };
        Plugin.Logger.Error(what + splits + ".");
    }

    internal static void LevelCleanup() { _header = null; Close(); }

    private static void Close()
    {
        try { PlayerRecorder.Stop(); }
        catch (Exception error) { Plugin.Logger.Error("Finishing the recording failed: " + error); }
        var finished = _stream != null;
        var path = FilePath;
        _stream?.Dispose();
        // The file is finished and closed: from here it is an ordinary recording the list may star or delete.
        _stream = null; _writer = null; FilePath = null;
        // Only the newest non-starred recordings stay (PLAN: the list's retention rule). The folder and the closed file are read on a worker
        // thread, not on the frame that cleans the level up; the finished event is raised on the main thread when that is done.
        if (!finished) return;
        var folder = Plugin.ReplayFolder;
        var limit = Math.Max(0, Plugin.DiskLimitMb.Value) * 1048576L;
        System.Threading.Tasks.Task.Run(() =>
        {
            try { ReplayLibrary.Prune(folder, limit); }
            catch (Exception error) { Plugin.Logger.Error("Removing old recordings failed: " + error.Message); }
            try { if (path != null && File.Exists(path)) Closed.Enqueue(ReplayLibrary.One(path, starred: false)); }
            catch (Exception error) { Plugin.Logger.Error("Reading the finished recording failed: " + error.Message); }
        });
    }

    private static readonly System.Collections.Concurrent.ConcurrentQueue<ReplayEntry> Closed = new();

    /// <summary>Every frame: raises the finished event for each recording the worker thread has read since.</summary>
    internal static void RaiseFinished()
    {
        while (Closed.TryDequeue(out var entry)) ReplayEvents.Finished(ReplayEvents.Info(entry));
    }
}
