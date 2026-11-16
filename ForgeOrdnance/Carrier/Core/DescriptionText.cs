using System;
using System.Collections.Generic;
using System.Globalization;

namespace ForgeOrdnance;

/// <summary>Implemented by a payload's parameter object (what <see cref="IOrdnancePayloadParser.Parse"/> returns) whose numbers a
/// description may show: the description's <c>{0}</c>, <c>{1}</c>… are these values in this order, read from the same parameters the
/// payload plays with, so the text always says what the call-in does.</summary>
public interface IOrdnanceDescribed
{
    /// <summary>The numbers a description's placeholders show, in the order the payload type documents.</summary>
    IReadOnlyList<double> DescriptionValues { get; }
}

/// <summary>How a number reaches a player text: one format for every language; the unit is a word of the language file.</summary>
internal static class DescriptionText
{
    /// <summary>A number as the player sees it: invariant digits, at most one decimal.</summary>
    internal static string Number(double value) => value.ToString("0.#", CultureInfo.InvariantCulture);

    /// <summary>The definition's numbers for its description (<see cref="IOrdnanceDescribed"/>), none when its parameters give none.</summary>
    internal static IReadOnlyList<double> Values(OrdnanceDefinition definition) =>
        definition.Parameters is IOrdnanceDescribed described ? described.DescriptionValues : Array.Empty<double>();

    /// <summary><paramref name="text"/> with each <c>{n}</c> replaced by <see cref="Number"/> of <c>values[n]</c>; false (and the text
    /// unchanged) when a placeholder has no value or the text is not a valid format.</summary>
    internal static bool TryFill(string text, IReadOnlyList<double> values, out string filled)
    {
        var args = new object[values.Count];
        for (var i = 0; i < args.Length; i++) args[i] = Number(values[i]);
        try
        {
            filled = string.Format(CultureInfo.InvariantCulture, text, args);
            return true;
        }
        catch (FormatException)
        {
            filled = text;
            return false;
        }
    }
}
