using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Schema;
using System.Text.Json.Serialization.Metadata;
using ForgeSkin.Format;

namespace ForgeSkin.Backend;

// Protocol methods (PLAN §3.3). Each takes the request params and returns a JSON-serialisable result. The editor edits
// character skins only: the game is read for profiles and the plugin's log, never for its assets.
public static class Methods
{
    public static string Version => typeof(Methods).Assembly.GetName().Version!.ToString(3);

    // A param of the wrong type is the request's fault (bad-request); errors inside the methods are not.
    static T? Opt<T>(JsonObject p, string name)
    {
        try { return p[name] is { } node ? node.Deserialize<T>(Program.Json) : default; }
        catch (JsonException e) { throw new BackendException("bad-request", $"{name}: {e.Message}"); }
    }

    static T Get<T>(JsonObject p, string name) => Opt<T>(p, name) ?? throw new BackendException("bad-request", $"{name} missing");

    // A path the caller names must be absolute. A rooted but drive-less one ("\autosave\character\...") means a different place on
    // every drive and made a project's files land on the drive's root; refusing it here keeps one bad path from becoming a stray work.
    static string Full(JsonObject p, string name)
    {
        var path = Str(p, name);
        return Path.IsPathFullyQualified(path) ? path : throw new BackendException("bad-request", $"{name}: {path} must be an absolute path");
    }

    static string Str(JsonObject p, string name) => Get<string>(p, name);

    static SkinDocument Doc(JsonObject p) => Projects.Absolute(Get<SkinDocument>(p, "project"));

    // Requests run in parallel. Methods that read, change and write a file (settings.json, active.json, projects, plugin
    // files) take one gate; the long ones that write packs and mods take another, so a build or an apply does not hold up a
    // project save.
    static readonly Lock FileGate = new(), JobGate = new();
    static readonly HashSet<string> FileWrites = ["game.setDir", "profiles.add", "profiles.remove", "project.save", "project.delete",
        "pack.install", "pack.list", "pack.remove", "pack.adopt", "pack.activate", "plugin.install", "plugin.uninstall", "dance.install"];
    static readonly HashSet<string> Jobs = ["pack.build", "pack.exportMod"];

    public static object? Call(string method, JsonObject p, long id)
    {
        var gate = FileWrites.Contains(method) ? FileGate : Jobs.Contains(method) ? JobGate : null;
        if (gate == null) return Dispatch(method, p, id);
        lock (gate) return Dispatch(method, p, id);
    }

    static object? Dispatch(string method, JsonObject p, long id) => method switch
    {
        "game.locate" => Game.Locate(Opt<string>(p, "profile")),
        "game.setDir" => Game.SetDir(Str(p, "dir")),
        "plugin.log" => Game.PluginLog(Str(p, "profile"), Opt<DateTime?>(p, "since"), Opt<long>(p, "from"), Opt<string>(p, "head")),
        "profiles.list" => Game.Profiles(),
        "profiles.get" => Game.ProfileAt(Str(p, "path")),
        "profiles.add" => Game.AddProfile(Str(p, "path")),
        "profiles.remove" => Game.RemoveProfile(Str(p, "path")),
        "project.load" => Projects.Load(Full(p, "path")),
        "project.save" => Projects.Save(Doc(p), Full(p, "path")),
        "project.list" => Projects.List(Full(p, "dir")),
        "project.delete" => Projects.Delete(Full(p, "path")),
        "springs.presets" => CharacterPreview.Presets(),
        "springs.simulate" => CharacterPreview.Simulate(Get<SpringChain>(p, "chain"), Get<List<CharacterPreview.Node>>(p, "nodes"),
            Opt<List<int[]>>(p, "strands"), Get<List<CharacterPreview.Frame>>(p, "frames"), Opt<List<CharacterPreview.Shell>>(p, "shells"),
            Opt<double[]>(p, "rest"), Opt<double?>(p, "scale")),
        "character.check" => CharacterPreview.Check(Get<Dictionary<string, double[]>>(p, "joints")),
        "character.links" => CharacterPreview.Links(Str(p, "descriptor"), Get<Dictionary<string, string>>(p, "bones"), Get<bool>(p, "fingers")),
        "character.arms" => CharacterPreview.Arms(Str(p, "descriptor"), Str(p, "mesh"), Get<Dictionary<string, string>>(p, "bones"), Opt<List<int>>(p, "hide")),
        "pack.build" => PackBuilder.Build(Doc(p), Str(p, "projectPath"), Str(p, "out"), id),
        "pack.install" => Install.Pack(Str(p, "pack"), Str(p, "profile"), Opt<bool?>(p, "activate") ?? true, Opt<bool?>(p, "pick") ?? false),
        "pack.list" => Install.List(Str(p, "profile"), Opt<bool?>(p, "tidy") ?? false),
        "pack.remove" => Install.Remove(Str(p, "profile"), Str(p, "skinId")),
        "pack.picture" => Install.Picture(Str(p, "pack"), Str(p, "cache")),
        "pack.adopt" => Projects.Adopt(Str(p, "pack"), Full(p, "dir"), Opt<List<string>>(p, "taken") ?? []),
        "pack.activate" => Install.Activate(Str(p, "profile"), Str(p, "skinId")),
        "pack.exportMod" => ModExport.Export(Get<string[]>(p, "packs"), Str(p, "out"), Str(p, "name"), Str(p, "version"), Opt<string>(p, "description") ?? "", Str(p, "icon")),
        "plugin.install" => Install.Plugin(Str(p, "profile")),
        "plugin.uninstall" => Install.PluginUninstall(Str(p, "profile")),
        "plugin.loadCheck" => LoadLog.Check(Str(p, "profile")),
        "dance.install" => Dance.Install(Str(p, "profile"), Full(p, "dir"), Opt<string>(p, "name")),
        "schema" => Schema(),
        _ => throw new BackendException("bad-request", $"Unknown method {method}"),
    };

    static JsonNode Schema()
    {
        var options = new JsonSerializerOptions(SkinJson.Options) { TypeInfoResolver = new DefaultJsonTypeInfoResolver() };
        return options.GetJsonSchemaAsNode(typeof(SkinDocument));
    }
}