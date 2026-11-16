using System.Text.Json;
using System.Text.RegularExpressions;
using ForgeOrdnance.Arsenal;
using ForgeOrdnance.Frames;
using ForgeUI;

namespace ForgeOrdnance.Tests;

/// <summary>The player texts of all three parts: a number a setting decides is never written into a text (it comes through a
/// <c>{n}</c> filled from the definition, <see cref="DescriptionText"/>), every language has the same placeholders as <c>en</c>, and
/// every description's placeholders have a number from its payload.</summary>
internal static class TextChecks
{
    private static readonly Regex Placeholder = new(@"\{\d+(?:[,:][^}]*)?\}");
    /// <summary>A written number: digits, an English number word, or a Chinese numeral before a counting or unit word.</summary>
    private static readonly Regex Written = new(@"\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twice|thrice|half|single)\b|[一二两三四五六七八九十][秒米发枚轮颗支个次]",
        RegexOptions.IgnoreCase);

    /// <summary>Texts whose written number no setting decides, each with why.</summary>
    private static readonly Dictionary<string, string> Narrative = new(StringComparer.Ordinal)
    {
        ["picker.clash"] = "'one code starts the other' / '一个指令': either of the two codes, not a count",
        ["arsenal.strike.precision.Description"] = "the Precision kind always drops exactly one shell; no field holds that count",
        ["arsenal.strike.hunter.Description"] = "the Hunter kind always fires exactly one shell after the laser; no field holds that count",
        ["arsenal.weapon.antimateriel.Description"] = "'single-shot' is the lent gear's firing action, not a number Ordnance sets",
        ["arsenal.weapon.recoilless.Description"] = "'single-shot' is the lent gear's firing action, not a number Ordnance sets",
    };

    internal static void Run(Action<bool, string> check)
    {
        // ---- the check catches what it is for ---------------------------------------------------------------------------
        check(Hardcoded("x.lang", new() { ["k.Description"] = "Lands within 15 m." }).Count == 1, "a hard-written number with a unit is caught");
        check(Hardcoded("x.lang", new() { ["k.Description"] = "Seven shells, {0} s." }).Count == 1 && Hardcoded("x.lang", new() { ["k"] = "发射四枚火箭" }).Count == 1,
            "a number written as a word is caught in both languages");
        check(Hardcoded("x.lang", new() { ["k.Description"] = "Lands within {4} m over {5:0} s." }).Count == 0, "numbers through placeholders pass");
        check(Unpaired("x", new() { ["k"] = "{0} m" }, new() { ["k"] = "15 米" }).Count == 1 && Unpaired("x", new() { ["k"] = "{0} m" }, new() { ["k"] = "{1} 米" }).Count == 1
            && Unpaired("x", new() { ["k"] = "{0} m", ["j"] = "a" }, new() { ["k"] = "{0} 米" }).Count == 1, "placeholders that differ from en, or a missing text, are caught");
        check(!DescriptionText.TryFill("for {5} s", new double[] { 1, 2 }, out var unfilled) && unfilled == "for {5} s"
            && DescriptionText.TryFill("{1} m, {0} s", new double[] { 20, 7.24 }, out var filled) && filled == "7.2 m, 20 s",
            "a placeholder without a number is refused; numbers show with at most one decimal");

        // ---- the shipped texts -----------------------------------------------------------------------------------------
        var problems = new List<string>();
        foreach (var folder in new[] { "lang", Path.Combine("Arsenal", "Definitions", "lang"), Path.Combine("Frames", "Definitions", "lang") })
        {
            var en = Table(Path.Combine(ModFolder.Path, folder, "en.forge"));
            var zh = Table(Path.Combine(ModFolder.Path, folder, "zh.forge"));
            problems.AddRange(Hardcoded(folder + "/en.forge", en));
            problems.AddRange(Hardcoded(folder + "/zh.forge", zh));
            problems.AddRange(Unpaired(folder, en, zh));
        }
        check(problems.Count == 0, "player texts write no number a setting decides, and zh has en's placeholders: " + string.Join(" | ", problems));

        // Every description, as the file writes it and in each language, fills from its own definition's numbers.
        var described = new List<(string Id, string File, IReadOnlyList<double> Values)>();
        var registry = new PayloadRegistry();
        registry.Register(StrikeSpec.TypeName, new StrikeParser());
        registry.Register(HeavyWeaponSpec.TypeName, new HeavyParser());
        registry.Register(DeployableSpec.TypeName, new DeployableParser());
        registry.Register("Item", new ItemParser());
        registry.Register("Gear", new GearParser());
        var arsenal = DefinitionParser.ParseFile("arsenal.forge", File.ReadAllText(Path.Combine(ModFolder.Path, "Arsenal", "Definitions", "arsenal.forge")), registry, new CategoryRegistry(id => () => id));
        described.AddRange(arsenal.Definitions.Select(d => (d.Id, d.Description, DescriptionText.Values(d))));
        using (var frames = JsonDocument.Parse(File.ReadAllText(Path.Combine(ModFolder.Path, "Frames", "Definitions", "frames.forge"))))
            foreach (var entry in frames.RootElement.EnumerateArray())
                described.Add((entry.GetProperty("Id").GetString()!, entry.GetProperty("Description").GetString()!, FrameSpecParser.Parse(entry.GetProperty("Payload")).DescriptionValues));
        var unfillable = new List<string>();
        var languages = new[] { "Arsenal", "Frames" }.SelectMany(part => new[] { "en", "zh" }.Select(code => Table(Path.Combine(ModFolder.Path, part, "Definitions", "lang", code + ".forge")))).ToList();
        check(described.Count == arsenal.Definitions.Count + 4 && described.All(d => d.Values.Count > 0 || !d.File.Contains('{')), "every shipped definition is read for its description");
        foreach (var (id, file, values) in described)
        {
            problems.AddRange(Hardcoded(id + " file", new() { [id + ".Description"] = file }));
            foreach (var text in languages.Where(t => t.ContainsKey(id + ".Description")).Select(t => t[id + ".Description"]).Prepend(file))
                if (!DescriptionText.TryFill(text, values, out _)) unfillable.Add(id + ": " + text);
        }
        check(problems.Count == 0, "definition files write no number a setting decides: " + string.Join(" | ", problems));
        check(unfillable.Count == 0, "every description placeholder has a number from its payload: " + string.Join(" | ", unfillable));
    }

    /// <summary>Each text that writes a number itself instead of through a placeholder, unless <see cref="Narrative"/> explains it.</summary>
    private static List<string> Hardcoded(string file, Dictionary<string, string> table)
    {
        var found = new List<string>();
        foreach (var (key, text) in table)
        {
            var match = Written.Match(Placeholder.Replace(text, ""));
            if (match.Success && !Narrative.ContainsKey(key)) found.Add(file + " '" + key + "' writes '" + match.Value + "' itself: " + text);
        }
        return found;
    }

    /// <summary>Each key missing from one language, and each text whose placeholders differ from the <c>en</c> text.</summary>
    private static List<string> Unpaired(string folder, Dictionary<string, string> en, Dictionary<string, string> zh)
    {
        var found = new List<string>();
        foreach (var key in en.Keys.Union(zh.Keys))
        {
            if (!en.TryGetValue(key, out var english) || !zh.TryGetValue(key, out var chinese)) { found.Add(folder + " '" + key + "' is in one language only"); continue; }
            if (UITexts.Placeholders(english) != UITexts.Placeholders(chinese)) found.Add(folder + " '" + key + "' placeholders differ: " + english + " / " + chinese);
        }
        return found;
    }

    private static Dictionary<string, string> Table(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path), new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
        return doc.RootElement.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!, StringComparer.Ordinal);
    }
}
