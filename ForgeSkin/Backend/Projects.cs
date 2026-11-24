using System.Text.Json.Nodes;
using ForgeSkin.Format;

namespace ForgeSkin.Backend;

// `Edited`: when the author last changed the work (the editor keeps it in editor.editedAt; a save without a change keeps it).
// `Adopted`: made from someone else's installed pack (editor.adopted, Adopt): its id is that pack's, so deleting the work
// leaves the pack installed.
public sealed record ProjectEntry(string Path, string Id, string Name, DateTime Modified, string? Edited = null, bool Adopted = false);

// Editor projects (.forgeskinproj = SkinDocument with paths relative to the file).
// In the protocol every file reference is absolute (Absolute); Load and Save convert.
public static class Projects
{
    public static SkinDocument Load(string path)
    {
        if (!File.Exists(path)) throw new BackendException("not-found", $"{path} not found");
        var dir = Path.GetDirectoryName(Path.GetFullPath(path))!;
        // A damaged file is the file's fault (schema), not the backend's.
        SkinDocument doc;
        try
        {
            var json = JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? throw new SkinFormatException("schema", $"{path} is empty");
            doc = SkinJson.Read(json.ToJsonString());
        }
        catch (Exception e) when (e is System.Text.Json.JsonException or InvalidOperationException or FormatException)
        {
            throw new SkinFormatException("schema", $"{path}: {e.Message}");
        }
        MapPaths(doc, p => Moved(Path.GetFullPath(Path.Combine(dir, p))));
        return doc;
    }

    static bool Under(string p, string root) =>
        Path.GetFullPath(p).StartsWith(Path.GetFullPath(root).TrimEnd('\\', '/') + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    // A file that is gone but was in a former data folder is taken from the same place in the current one when it is
    // there (the data folder moved); anything else stays as named, and a missing file is reported as before. The next
    // save writes the new place.
    static string Moved(string path)
    {
        if (File.Exists(path)) return path;
        foreach (var former in Paths.FormerData.Where(f => Under(path, f)))
        {
            var now = Path.Combine(Paths.Data, Path.GetRelativePath(former, path));
            if (File.Exists(now)) return now;
        }
        return path;
    }

    // The projects in a folder (the character works), newest first. A file that does not parse is listed under its file
    // name, so loading it reports the damage instead of the skin silently disappearing.
    public static List<ProjectEntry> List(string dir) => !Directory.Exists(dir) ? new() : Directory.GetFiles(dir, "*.forgeskinproj").Select(file =>
    {
        var name = Path.GetFileNameWithoutExtension(file);
        JsonObject? json = null;
        try { json = JsonNode.Parse(File.ReadAllText(file)) as JsonObject; } catch (System.Text.Json.JsonException) { json = null; }
        var editor = json?["editor"] as JsonObject;
        return new ProjectEntry(file, (string?)json?["id"] ?? name, (string?)json?["name"] ?? name, File.GetLastWriteTimeUtc(file), editor?["editedAt"]?.GetValue<string>(),
            editor?["adopted"] is JsonValue v && v.TryGetValue<bool>(out var adopted) && adopted);
    }).OrderByDescending(e => e.Modified).ToList();

    public static object Delete(string path)
    {
        // A character work or a dance: the project file and the folder beside it (<id>.character / <id>.dancework).
        var dance = path.EndsWith(".danceproj", StringComparison.OrdinalIgnoreCase);
        if (!dance && !path.EndsWith(".forgeskinproj", StringComparison.OrdinalIgnoreCase)) throw new BackendException("bad-request", $"{path} is not a project file");
        // To the Recycle Bin, so a deleted work can be put back; its snapshots and a character's converted model go with it.
        // All or nothing: everything is first checked to be free (a folder another program holds open cannot be moved, and
        // a half-deleted work would lose its project yet keep its files), then the folders go before the project, so a
        // failure still leaves the work listed.
        var folders = (dance ? new[] { ".dancework" } : new[] { ".snapshots", ".character" })
            .Select(e => Path.ChangeExtension(path, e)).Where(Directory.Exists).ToList();
        // What the editor made from this work besides the project: the pack a last apply built and its card picture. They are
        // never used by another work, so they go with it (an apply builds the pack again).
        string? id = null;
        try { id = (string?)(JsonNode.Parse(File.ReadAllText(path)) as JsonObject)?["id"]; } catch (System.Text.Json.JsonException) { }
        id ??= Path.GetFileNameWithoutExtension(path);
        var made = !dance ? new[]
        {
            Path.Combine(Paths.Data, "packs", Names.Safe(id) + SkinPack.Extension),
            Path.Combine(Paths.Data, "export", Names.Safe(id) + "-icon.png"),
        }.Where(File.Exists).ToList() : new List<string>();
        // A file just written is often read for a moment by another program (a virus scan, the thumbnail cache): asked again a few
        // times before the delete is refused.
        string? held = null;
        for (var attempt = 0; attempt < 5; attempt++)
        {
            held = folders.FirstOrDefault(InUse) ?? made.FirstOrDefault(FileInUse) ?? (File.Exists(path) && FileInUse(path) ? path : null);
            if (held == null) break;
            Thread.Sleep(200);
        }
        if (held != null) throw new BackendException("work-in-use", $"{held} is open in another program");
        foreach (var folder in folders) RecycleBin.Send(folder);
        foreach (var file in made) RecycleBin.Send(file);
        RecycleBin.Send(path);
        return new { removed = path };
    }

    // An installed character pack made into one of the author's works (「搬到我的作品」): its manifest saved as the project
    // `<dir>/<id>.forgeskinproj` and its files unpacked into `<id>.textures/` beside it, a precompressed texture decoded back to PNG
    // (the editor reads only pictures). `lost` names what a pack no longer holds, which the work comes back without: for a
    // character "source" (the model file it was made from is not in a pack, so the model itself cannot be imported again), and
    // "missing" for a file the manifest names that is not in the pack. `picture`: the pack's card picture as unpacked, null
    // without one. A name among `taken` (the author's works) gets " 2", " 3", ... as a new work's does.
    public static object Adopt(string pack, string dir, IReadOnlyCollection<string> taken)
    {
        using var p = SkinPack.Open(pack);
        var doc = SkinJson.Read(SkinJson.Write(p.Manifest));
        var name = doc.Name;
        for (var n = 2; taken.Contains(doc.Name); n++) doc.Name = $"{name} {n}";
        var path = Path.GetFullPath(Path.Combine(dir, Names.Safe(doc.Id) + ".forgeskinproj"));
        if (File.Exists(path)) throw new BackendException("bad-request", $"{path} already exists");
        var files = Path.ChangeExtension(path, ".textures");
        var lost = new SortedSet<string> { "source" };
        doc.Editor = new() { ["adopted"] = true };
        Unpack(p, doc, files, lost);
        Save(doc, path);
        return new { path, weapon = doc.Target.Weapon, name = doc.Name, lost, picture = doc.Character?.Picture };
    }

    // Unpacks every file `doc` (read from `p`'s manifest) names into `files`, keeping the pack's folders, and points `doc` at the
    // copies; a precompressed texture is decoded back to PNG ("compressed" in `lost`), a file the pack lacks is "missing".
    internal static void Unpack(SkinPack p, SkinDocument doc, string files, ISet<string> lost)
    {
        var channels = new Dictionary<string, TextureChannel>();
        foreach (var d in doc.Materials.SelectMany(m => (m.Wear ?? []).Select(w => w.Textures).Prepend(m.Textures)).Concat(doc.Attachments.Where(a => a.Material != null).Select(a => a.Material!.Textures)))
            foreach (var (ch, file) in d) channels.TryAdd(file, ch);
        var done = new Dictionary<string, string>();
        MapPaths(doc, name =>
        {
            if (done.TryGetValue(name, out var to)) return to;
            to = Path.Combine(files, name.Replace('/', Path.DirectorySeparatorChar));
            byte[] bytes;
            try { bytes = p.ReadBytes(name); }
            catch (SkinFormatException) { lost.Add("missing"); return done[name] = to; }
            Directory.CreateDirectory(Path.GetDirectoryName(to)!);
            if (Dds.IsDds(bytes))
            {
                to = Path.ChangeExtension(to, ".png");
                bytes = Precompress.Png(bytes, channels.GetValueOrDefault(name, TextureChannel.Albedo), name);
                lost.Add("compressed");
            }
            File.WriteAllBytes(to, bytes);
            return done[name] = to;
        });
    }

    // A folder some program holds open (a watcher, a file opened in it) cannot be renamed; moving it away and back tells.
    static bool InUse(string folder)
    {
        var probe = folder + ".deleting";
        try
        {
            Directory.Move(folder, probe);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return true;
        }
        Directory.Move(probe, folder);
        return Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories).Any(FileInUse);
    }

    static bool FileInUse(string file)
    {
        try
        {
            using var _ = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            return false;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return true; // locked, or read-only (the Recycle Bin would refuse it too)
        }
    }

    // The files a document names, in document order, each once.
    public static List<string> Files(SkinDocument doc)
    {
        var files = new List<string>();
        MapPaths(doc, p =>
        {
            if (!files.Contains(p)) files.Add(p);
            return p;
        });
        return files;
    }

    // A document in the protocol names every file by its absolute path: only the project file on disk holds relative ones,
    // and Load and Save own that conversion. A relative one here is a project file's text that reached the editor without
    // Load; resolving it against any folder would be a guess, so it is refused.
    public static SkinDocument Absolute(SkinDocument doc) =>
        Files(doc).FirstOrDefault(p => !Path.IsPathFullyQualified(p)) is { } relative
            ? throw new BackendException("bad-request", $"{relative}: a file the skin names must be an absolute path (project.load gives a project file's paths absolute)")
            : doc;

    public static object Save(SkinDocument doc, string path)
    {
        path = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(dir);
        var copy = SkinJson.Read(SkinJson.Write(doc));
        // Relative only what moves with the project (under its folder or the data folder); a file elsewhere stays absolute,
        // so a project file copied to another folder still finds it.
        MapPaths(copy, p => Under(p, dir) || Under(p, Paths.Data) ? Path.GetRelativePath(dir, p).Replace('\\', '/') : p);
        AtomicFile.WriteText(path, SkinJson.Write(copy));
        return new { path };
    }

    // A font is a family name (bundled or installed) or a font file.
    static bool FontFile(string font) => Path.GetExtension(font).ToLowerInvariant() is ".ttf" or ".otf" or ".woff" or ".woff2";

    // Every file reference in a document (texture, layer source, decal image, font file, mesh, part mesh, atlas, sound, a
    // character's model and its pictures). A texture slot without a file is dropped (the game texture stays).
    public static void MapPaths(SkinDocument doc, Func<string, string> map)
    {
        static void Dict(Dictionary<TextureChannel, string> d, Func<string, string> map)
        {
            foreach (var k in d.Keys.ToList())
                if (string.IsNullOrEmpty(d[k])) d.Remove(k);
                else d[k] = map(d[k]);
        }
        foreach (var m in doc.Materials)
        {
            Dict(m.Textures, map);
            foreach (var w in m.Wear ?? []) Dict(w.Textures, map);
            foreach (var l in m.Layers)
            {
                if (l.Kind != LayerKind.Text) l.Sources = l.Sources.Select(map).ToList();
                if (l.Text?.Font is { } font && FontFile(font)) l.Text.Font = map(font);
                if (l.Atlas != null) l.Atlas.Path = map(l.Atlas.Path);
            }
            foreach (var l in m.Livery ?? [])
            {
                if (l.Image != null) l.Image = map(l.Image);
                if (l.Text?.Font is { } font && FontFile(font)) l.Text.Font = map(font);
            }
        }
        foreach (var a in doc.Attachments)
        {
            if (a.Mesh != null) a.Mesh = map(a.Mesh);
            if (a.Material != null) Dict(a.Material.Textures, map);
            if (a.Screen?.Font is { } font && FontFile(font)) a.Screen.Font = map(font);
        }
        foreach (var t in doc.Parts.Where(t => t.Mesh != null)) t.Mesh = map(t.Mesh!);
        foreach (var s in doc.Sounds.Where(s => !string.IsNullOrEmpty(s.File))) s.File = map(s.File);
        foreach (var m in new[] { doc.Character?.Model, doc.Character?.Arms?.Model })
        {
            if (m == null) continue;
            if (m.Descriptor.Length > 0) m.Descriptor = map(m.Descriptor);
            if (m.Mesh.Length > 0) m.Mesh = map(m.Mesh);
            m.Textures = m.Textures.Select(map).ToList();
        }
        if (doc.Character?.Picture is { Length: > 0 } picture) doc.Character.Picture = map(picture);
        if (doc.Picture is { Length: > 0 } own) doc.Picture = map(own);
    }
}