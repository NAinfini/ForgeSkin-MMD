using System.IO.Compression;
using System.Text;
using System.Text.Json;
using ForgeSkin.Format;

namespace ForgeSkin.Backend;

// A character project -> .forgeskin: the converted model's files and its card picture copied in, the manifest written, and the
// pack read back the way the plugin reads it before it is put anywhere near a game.
public static class PackBuilder
{
    public static object Build(SkinDocument project, string projectPath, string outPath, long requestId)
    {
        var doc = SkinJson.Read(SkinJson.Write(project));
        if (doc.Character is not { } person) throw new BackendException("bad-request", "pack.build takes a character skin (a document with `character`)");
        // A character's credit (the line its model's licence asks for, read from the file by the editor) goes in the pack as CREDITS.txt.
        var credit = doc.Editor?.GetValueOrDefault("credit") is JsonElement { ValueKind: JsonValueKind.String } line ? line.GetString() : null;
        doc.Editor = null;
        var warnings = new List<string>();
        if (string.IsNullOrWhiteSpace(doc.Id)) doc.Id = "skin-" + Guid.NewGuid().ToString("N")[..12];
        if (!outPath.EndsWith(SkinPack.Extension, StringComparison.OrdinalIgnoreCase)) outPath = Path.Combine(outPath, Names.Safe(doc.Id) + SkinPack.Extension);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
        using var temp = new AtomicFile(outPath);
        // The model's files (and the arms' model), the picture, the credit and the manifest.
        int total = 1 + 2 + person.Model.Textures.Count + (person.Arms?.Model is { } arms ? 2 + arms.Textures.Count : 0) + (person.Picture != null ? 1 : 0) + (credit != null ? 1 : 0);
        int done = 0;
        using (var zip = ZipFile.Open(temp.Temp, ZipArchiveMode.Create))
        {
            // Every entry name passes the loader's path rule here, so a name the game would refuse fails the build.
            string Name(string name)
            {
                SkinPack.RequirePath(name, name);
                return name;
            }
            void Copy(string name, string file)
            {
                if (!File.Exists(file)) throw new SkinFormatException("missing-file", $"{file} missing");
                // Pictures are compressed already: deflating them again costs time and saves nothing. The model mesh and its
                // descriptor are big and only need to get smaller, so they go in fast rather than as small as possible.
                var level = Path.GetExtension(file).ToLowerInvariant() is ".png" or ".jpg" or ".jpeg" ? CompressionLevel.NoCompression : CompressionLevel.Fastest;
                zip.CreateEntryFromFile(file, Name(name), level);
                Program.Progress(requestId, ++done, total, name);
            }
            // A character's model (ImportedModels format 2, converted by the editor) goes in as it is: character/model.json, .forgemesh, t<i>.png.
            void Model(CharacterModelFiles? m, string stem, string textures)
            {
                if (m == null) return;
                Copy($"character/{stem}.json", m.Descriptor);
                Copy($"character/{stem}.forgemesh", m.Mesh);
                (m.Descriptor, m.Mesh) = ($"character/{stem}.json", $"character/{stem}.forgemesh");
                m.Textures = m.Textures.Select((file, i) =>
                {
                    Copy($"character/{textures}{i}.png", file);
                    return $"character/{textures}{i}.png";
                }).ToList();
            }
            Model(person.Model, "model", "t");
            Model(person.Arms?.Model, "arms", "arms_t");
            if (person.Picture != null)
            {
                Copy("character/picture.png", person.Picture);
                person.Picture = "character/picture.png";
            }
            if (!string.IsNullOrWhiteSpace(credit))
            {
                using var s = new StreamWriter(zip.CreateEntry(CreditsName).Open());
                s.Write(credit.Trim() + "\n");
                Program.Progress(requestId, ++done, total, "CREDITS.txt");
            }

            using (var s = new StreamWriter(zip.CreateEntry(SkinPack.ManifestName).Open()))
                s.Write(SkinJson.Write(doc));
        }

        using (var built = SkinPack.Open(temp.Temp))
        {
            CheckSounds(built);
            CheckCharacter(built);
        }
        temp.Commit();
        Log.Write($"pack.build {doc.Id} written to {outPath}", echo: false);
        Program.Progress(requestId, total, total, "done");
        return new { pack = Path.GetFullPath(outPath), warnings, memory = 0L };
    }

    /// <summary>The pack entry holding the credit a character model's licence asks for; a skin mod's README repeats it.</summary>
    public const string CreditsName = "CREDITS.txt";

    // A character pack read back as the plugin reads it: the descriptor parses, the mesh and textures are the ones it names, and the bone
    // map, springs, capsules and materials fit its skeleton (CharacterRig.Check). Anything else is refused before it reaches a game.
    public static void CheckCharacter(SkinPack pack)
    {
        if (pack.Manifest.Character is not { } person) return;
        foreach (var m in new[] { person.Model, person.Arms?.Model })
        {
            if (m == null) continue;
            var model = ForgeVisual.ImportedModelDescriptor.Parse(Encoding.UTF8.GetString(pack.ReadBytes(m.Descriptor)), out var failure)
                ?? throw new SkinFormatException("bad-character-model", $"{m.Descriptor}: {failure}");
            if (CharacterRig.Matches(model, pack.ReadBytes(m.Mesh), m.Textures.Select(pack.ReadBytes).ToList()) is { } wrong)
                throw new SkinFormatException("bad-character-model", $"{m.Descriptor}: {wrong}");
            if (m == person.Model && CharacterRig.Check(person, model) is { Length: > 0 } misfit)
                throw new SkinFormatException("bad-character-rig", misfit);
        }
    }

    // Every sound of a pack through the audio kit's own container check (ForgeCore AssetValidation, linked): a pack the game
    // would refuse when it loads the sounds (bad-audio) is refused here, naming the sound.
    public static void CheckSounds(SkinPack pack)
    {
        foreach (var file in pack.Manifest.Sounds.Select(s => s.File).Distinct())
            if (ForgeAudio.AssetValidation.Ogg(pack.ReadBytes(file), SkinPack.MaxSoundSeconds) is { Success: false } bad)
                throw new SkinFormatException("bad-audio", $"{Path.GetFileName(file)}: {bad.Error.Detail}");
    }

    // The pack cache (texture atlases of the weapon editor) stays under CacheLimit: the least recently used files are deleted
    // first. Pruned at the backend's start and after each build, so an old cache clears itself.
    const long CacheLimit = 200L << 20;

    public static void PruneCache()
    {
        var dir = Path.Combine(Paths.Cache, "pack");
        if (!Directory.Exists(dir)) return;
        var files = new DirectoryInfo(dir).GetFiles().OrderByDescending(f => f.LastWriteTimeUtc).ToList();
        long total = files.Sum(f => f.Length);
        foreach (var f in files.AsEnumerable().Reverse())
        {
            if (total <= CacheLimit) break;
            var length = f.Length;
            try { f.Delete(); total -= length; }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { } // open: kept for the next prune
        }
    }
}