using SkiaSharp;
using ForgeSkin.Format;

namespace ForgeSkin.Backend;

// PNG decode and encode for the files a project keeps (an adopted pack's pictures).
public static class Images
{
    public static SKBitmap FromRgba(int w, int h, byte[] rgba)
    {
        var bmp = new SKBitmap(new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        System.Runtime.InteropServices.Marshal.Copy(rgba, 0, bmp.GetPixels(), rgba.Length);
        return bmp;
    }

    public static SKBitmap Load(string path)
    {
        var decoded = SKBitmap.Decode(path) ?? throw new SkinFormatException("bad-image", $"{path} is not a readable image");
        if (decoded.Copy(SKColorType.Rgba8888) is not { } copy) return decoded;
        decoded.Dispose();
        return copy;
    }

    // Straight (not premultiplied) RGBA rows from the top, as the game's decoder reads the file.
    public static SKBitmap Decode(byte[] image, string what)
    {
        using var codec = SKCodec.Create(new MemoryStream(image)) ?? throw new SkinFormatException("bad-image", $"{what}: not a readable image");
        return SKBitmap.Decode(codec, new SKImageInfo(codec.Info.Width, codec.Info.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
    }

    public static (int Width, int Height) Size(string path)
    {
        using var codec = SKCodec.Create(path) ?? throw new SkinFormatException("bad-image", $"{path} is not a readable image");
        return (codec.Info.Width, codec.Info.Height);
    }

    // Whole or not at all: a file that exists is complete (the preview store reuses any file it finds).
    public static void SavePng(SKBitmap bmp, string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var data = bmp.Encode(SKEncodedImageFormat.Png, 100);
        using var file = new AtomicFile(path);
        using (var f = File.Create(file.Temp)) data.SaveTo(f);
        file.Commit();
    }

    public static SKBitmap Resize(SKBitmap src, int w, int h) =>
        src.Width == w && src.Height == h ? src.Copy() : src.Resize(new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Unpremul), SKFilterQuality.High);
}