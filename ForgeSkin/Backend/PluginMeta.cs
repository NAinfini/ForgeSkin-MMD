using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace ForgeSkin.Backend;

// What a BepInEx plugin DLL declares about itself, read from its metadata without loading it: its [BepInPlugin] (GUID, name,
// version) and its [BepInDependency] entries (GUID and version range, ">=1.0.3"). The editor holds the plugins it installs to
// these, so a dependency minimum is written once, in the plugin's own attribute.
public sealed record PluginMeta(string Guid, string Name, string Version, IReadOnlyList<(string Guid, string? Range)> Dependencies)
{
    /// <summary>The plugin declared in `dll`, or null when it declares none or cannot be read (logged once per file).</summary>
    public static PluginMeta? Read(string dll)
    {
        try
        {
            using var stream = File.OpenRead(dll);
            using var pe = new PEReader(stream);
            if (!pe.HasMetadata) return null;
            var md = pe.GetMetadataReader();
            PluginMeta? found = null;
            var deps = new List<(string, string?)>();
            foreach (var handle in md.CustomAttributes)
            {
                var attribute = md.GetCustomAttribute(handle);
                var name = AttributeName(md, attribute);
                if (name is not ("BepInPlugin" or "BepInDependency")) continue;
                var args = attribute.DecodeValue(Strings.Instance).FixedArguments;
                if (name == "BepInPlugin" && args.Length == 3)
                    found = new PluginMeta((string)args[0].Value!, (string)args[1].Value!, (string)args[2].Value!, deps);
                else if (name == "BepInDependency" && args.Length >= 1)
                    deps.Add(((string)args[0].Value!, args.Length > 1 ? args[1].Value as string : null));
            }
            return found;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or BadImageFormatException or InvalidOperationException or InvalidCastException)
        {
            if (Unreadable.Add(dll)) Log.Write($"{dll}: plugin attributes not read ({e.Message})");
            return null;
        }
    }

    static readonly HashSet<string> Unreadable = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The lowest version of `guid` this plugin accepts (its BepInDependency ">=x.y.z"), or null when it names none.</summary>
    public System.Version? Minimum(string guid)
    {
        var range = Dependencies.FirstOrDefault(d => d.Guid == guid).Range;
        return range != null && System.Version.TryParse(range.TrimStart('>', '=', ' ', '~', '^'), out var v) ? v : null;
    }

    static string? AttributeName(MetadataReader md, CustomAttribute attribute)
    {
        if (attribute.Constructor.Kind != HandleKind.MemberReference) return null;
        var parent = md.GetMemberReference((MemberReferenceHandle)attribute.Constructor).Parent;
        if (parent.Kind != HandleKind.TypeReference) return null;
        var name = md.GetString(md.GetTypeReference((TypeReferenceHandle)parent).Name);
        return name.EndsWith("Attribute") ? name[..^"Attribute".Length] : name;
    }

    // Decodes attribute arguments far enough for strings and enums (BepInDependency's flags overload); types are named only.
    sealed class Strings : ICustomAttributeTypeProvider<string>
    {
        public static readonly Strings Instance = new();
        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();
        public string GetSystemType() => "System.Type";
        public string GetSZArrayType(string elementType) => elementType + "[]";
        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) => reader.GetString(reader.GetTypeDefinition(handle).Name);
        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) => reader.GetString(reader.GetTypeReference(handle).Name);
        public string GetTypeFromSerializedName(string name) => name;
        public PrimitiveTypeCode GetUnderlyingEnumType(string type) => PrimitiveTypeCode.Int32;
        public bool IsSystemType(string type) => type == "System.Type";
    }
}
