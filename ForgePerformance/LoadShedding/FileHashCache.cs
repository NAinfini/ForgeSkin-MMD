using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;

namespace ForgePerformance.LoadShedding;

/// <summary>The SHA-256 of a game file, kept across launches in one small text file (<see cref="Store"/>): a file whose full path,
/// length, last write time and creation time are the ones recorded is not read again. No cache, an unreadable or malformed one, or any
/// other key reads and hashes the file, so the cache only skips re-reading a file that has not changed; the caller still compares the
/// result with the expected hash every launch. ForgePerformance depends on no Forge package, so it keeps its own copy.</summary>
internal static class FileHashCache
{
    /// <summary>The cache file; null keeps nothing across launches.</summary>
    internal static string? Store;
    private static readonly object Gate = new();
    private static Dictionary<string, (string Key, string Hash)>? _known;

    internal static string Sha256(string path)
    {
        var info = new FileInfo(path);
        var key = Key(info);
        lock (Gate)
        {
            _known ??= Read();
            if (_known.TryGetValue(info.FullName, out var kept) && kept.Key == key) return kept.Hash;
        }
        string hash;
        using (var stream = info.OpenRead()) using (var sha = SHA256.Create()) hash = Convert.ToHexString(sha.ComputeHash(stream));
        info.Refresh();
        // A file that changed while it was read keeps no record: the next launch reads it again.
        if (Key(info) == key) lock (Gate) { _known[info.FullName] = (key, hash); Write(); }
        return hash;
    }

    private static string Key(FileInfo info) => info.Length + "\t" + info.LastWriteTimeUtc.Ticks + "\t" + info.CreationTimeUtc.Ticks;

    // One line per file: full path, length, last write ticks, creation ticks, hash. One bad line discards the whole file.
    private static Dictionary<string, (string Key, string Hash)> Read()
    {
        var known = new Dictionary<string, (string Key, string Hash)>(StringComparer.OrdinalIgnoreCase);
        try
        {
            if (Store == null || !File.Exists(Store)) return known;
            foreach (var line in File.ReadAllLines(Store))
            {
                var parts = line.Split('\t');
                if (parts.Length != 5 || !long.TryParse(parts[1], out _) || !long.TryParse(parts[2], out _) || !long.TryParse(parts[3], out _)
                    || parts[4].Length != 64 || !IsUpperHex(parts[4])) { known.Clear(); return known; }
                known[parts[0]] = (parts[1] + "\t" + parts[2] + "\t" + parts[3], parts[4]);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { known.Clear(); }
        return known;
    }

    private static bool IsUpperHex(string text)
    {
        foreach (var c in text) if (c is not (>= '0' and <= '9' or >= 'A' and <= 'F')) return false;
        return true;
    }

    // Written to a temporary file and moved over the old one; a cache that cannot be written only costs the next launch a read.
    private static void Write()
    {
        if (Store == null) return;
        try
        {
            var lines = new List<string>(_known!.Count);
            foreach (var (file, value) in _known) lines.Add(file + "\t" + value.Key + "\t" + value.Hash);
            Directory.CreateDirectory(Path.GetDirectoryName(Store)!);
            var temporary = Store + ".tmp";
            File.WriteAllLines(temporary, lines);
            File.Move(temporary, Store, true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
}
