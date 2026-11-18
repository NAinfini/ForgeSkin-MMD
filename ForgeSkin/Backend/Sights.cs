namespace ForgeSkin.Backend;

// One of the game's sight parts (GearSightPartDataBlock) as the sight group offers it: its aim fields of view (0: the gun's own)
// and, when it has one, the flat holographic lens a skin's lens can be drawn in the style of: the lens material and the catalog
// sight item whose preview shows it. Lens is null for a sight without a flat Unlit/HolographicSight_3Layers lens (iron sights,
// the floating holograms Sight_20, 21 and 24) or without a catalog item to preview it with.
public sealed record SightInfo(uint Id, string Name, int Gear, int World, string? Item, string? Lens);

public static class Sights
{
    // As ForgeCore SightLenses: the shader a vanilla lens is drawn with, and the thinnest axis a lens mesh has at most.
    const string Holographic = "Unlit/HolographicSight_3Layers";
    const float LensThickness = 0.02f;
    static List<SightInfo>? _list;
    static string? _build;

    public static List<SightInfo> List(GameAssets g)
    {
        if (_list != null && _build == g.BuildId) return _list;
        var items = Catalog.Get(g).Where(i => i.Category == "sight").ToDictionary(i => i.Name, i => i.Id);
        var list = new List<SightInfo>();
        foreach (var (id, row) in g.Blocks("GearSightPart").OrderBy(kv => kv.Key))
        {
            var name = (string)row["name"]!;
            var zoom = row["SightProperties"];
            int gear = (int?)zoom?["GearFovZoom"] ?? 0, world = (int?)zoom?["WorldFovZoom"] ?? 0;
            var model = (string?)row["General"]?["Model"];
            items.TryGetValue(name.Replace('_', ' '), out var item);
            string? lens = null;
            if (item != null && !string.IsNullOrEmpty(model) && g.TryPrefab(model, out _))
                lens = LensOf(g, Catalog.Build(g, new Recipe(Prefabs: [model], Slot: "sight")));
            list.Add(new SightInfo(id, name, gear, world, lens != null ? item : null, lens));
        }
        _build = g.BuildId;
        return _list = list;
    }

    // The material of the first flat mesh drawn with the holographic lens shader, as the plugin's SightLenses.Of takes it.
    static string? LensOf(GameAssets g, Node root)
    {
        foreach (var n in root.All())
        {
            if (n.Mesh == null || !n.Active) continue;
            foreach (var m in n.Materials)
            {
                if (m.PathId == 0 || Unity.ReadMaterial(g, m).Shader != Holographic) continue;
                var p = Unity.ReadMesh(g, n.Mesh).Positions;
                if (p.Length == 0) continue;
                var size = p.Aggregate((Min: p[0], Max: p[0]), (b, v) => (System.Numerics.Vector3.Min(b.Min, v), System.Numerics.Vector3.Max(b.Max, v)));
                var d = size.Max - size.Min;
                if (Math.Min(d.X, Math.Min(d.Y, d.Z)) <= LensThickness) return m.Name;
            }
        }
        return null;
    }
}
