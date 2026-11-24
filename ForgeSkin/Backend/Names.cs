namespace ForgeSkin.Backend;

// File names made from a document's ids and names.
public static class Names
{
    // A skin's id or a material's name as a file name: every character Windows refuses becomes '_'.
    public static string Safe(string name) => string.Concat(name.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c));
}