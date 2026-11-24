using System.Diagnostics;

namespace ForgeSkin.Backend;

// A dance the editor made, installed into a profile: the editor's own GtfoMmdDance plugin (with the ForgeCore and ForgeSkin it
// needs) and the dance's files under plugins/GtfoMmdDance/Dances/, where the plugin's F9 list finds them. BepInExPack_GTFO and
// GTFO_API are not this editor's to install; the check only says when they are missing, so the author can install them.
public static class Dance
{
    const string PluginFolder = "GtfoMmdDance", PluginDll = "GtfoMmdDance.dll";

    /** Files a dance carries beside its `.dance`: the camera move, the face morphs, the song. */
    static readonly HashSet<string> Extras = new(StringComparer.OrdinalIgnoreCase) { ".cam", ".face", ".wav" };

    /// <summary>The plugin folder this editor ships: `resources/dance/plugin` beside the backend (a packaged editor's resources
    /// folder, or the editor's own resources in a checkout).</summary>
    internal static string Source()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            foreach (var at in new[]
                     {
                         Path.Combine(dir.FullName, "dance", "plugin"),                    // a packaged editor: <resources>/dance/plugin, the backend in <resources>/publish
                         Path.Combine(dir.FullName, "resources", "dance", "plugin"),       // <editor>/resources/dance/plugin
                         Path.Combine(dir.FullName, "Editor", "resources", "dance", "plugin"), // from <repo>/ForgeSkin up to a checkout's Editor/
                     })
                if (File.Exists(Path.Combine(at, PluginDll))) return at;
        throw new BackendException("no-plugin", $"The dance plugin this editor installs is missing: {PluginDll} under resources/dance/plugin. "
            + "Reinstall the editor; in a checkout the file is Editor/resources/dance/plugin/GtfoMmdDance.dll.");
    }

    /// <summary>BepInEx 6 (IL2CPP) in the profile, by its core DLL.</summary>
    static bool HasBepInEx(string profile) =>
        File.Exists(Path.Combine(Game.BepInEx(profile), "core", "BepInEx.Core.dll"))
        || File.Exists(Path.Combine(Game.BepInEx(profile), "core", "BepInEx.Unity.IL2CPP.dll"));

    /// <summary>GTFO_API anywhere BepInEx loads DLLs from, by its assembly name.</summary>
    static string? GTFOApi(string profile)
    {
        var plugins = ForgeSkin.Backend.Install.Plugins(profile);
        if (!Directory.Exists(plugins)) return null;
        return Directory.EnumerateFiles(plugins, "GTFO-API.dll", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true }).FirstOrDefault();
    }

    /// <summary>
    /// Installs the plugin and `name`'s dance files (`files` is the folder the editor exported into), then reports what the profile
    /// still lacks. The plugin's own Dances/ and Avatars/ are never cleared: the author's other dances stay.
    /// </summary>
    public static object Install(string profile, string files, string? name)
    {
        ForgeSkin.Backend.Install.RequireProfile(profile);
        var source = Source();
        if (!Directory.Exists(files)) throw new BackendException("bad-request", $"no exported dance files at {files}");
        var baseName = string.IsNullOrWhiteSpace(name) ? null : Path.GetFileNameWithoutExtension(name);
        var home = Path.Combine(ForgeSkin.Backend.Install.Plugins(profile), PluginFolder);
        var dances = Path.Combine(home, "Dances");
        var shipped = Directory.GetFiles(source, "*", SearchOption.AllDirectories);
        var carried = baseName == null ? [] : Directory.GetFiles(files).Where(f => Path.GetFileNameWithoutExtension(f).Equals(baseName, StringComparison.OrdinalIgnoreCase)
            && (Path.GetExtension(f).Equals(".dance", StringComparison.OrdinalIgnoreCase) || Extras.Contains(Path.GetExtension(f)))).ToArray();
        if (baseName != null && !carried.Any(f => Path.GetExtension(f).Equals(".dance", StringComparison.OrdinalIgnoreCase)))
            throw new BackendException("bad-request", $"{files} has no {baseName}.dance to install");

        // Nothing is replaced while GTFO holds it; the plugin DLL the game loads is the one that matters here.
        ForgeSkin.Backend.Install.RequireUnlocked(Path.Combine(home, PluginDll));
        foreach (var file in shipped) Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(home, Path.GetRelativePath(source, file)))!);
        foreach (var file in shipped) File.Copy(file, Path.Combine(home, Path.GetRelativePath(source, file)), true);
        Directory.CreateDirectory(dances);
        Directory.CreateDirectory(Path.Combine(home, "Avatars"));
        foreach (var file in carried) File.Copy(file, Path.Combine(dances, Path.GetFileName(file)), true);
        Log.Write($"dance.install {profile}: {carried.Length} file(s) for {baseName ?? "no dance"} into {dances}");

        var missing = new List<string>();
        if (!HasBepInEx(profile)) missing.Add("BepInExPack_GTFO");
        if (GTFOApi(profile) == null) missing.Add("GTFO_API");
        return new
        {
            installed = home,
            dances,
            files = carried.Select(f => Path.GetFileName(f)).ToArray(),
            missing,
            version = VersionOf(Path.Combine(home, PluginDll)),
        };
    }

    static string? VersionOf(string dll)
    {
        try { return FileVersionInfo.GetVersionInfo(dll).FileVersion; } catch (IOException) { return null; }
    }
}