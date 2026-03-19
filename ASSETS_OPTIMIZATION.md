# Asset Optimization Guide

## Current Asset Sizes

| Asset | Current Size | Target Size | Dimensions |
|-------|-------------|-------------|------------|
| icon.png | 1,421 KB | <200 KB | 1024x1024 |
| adaptive-icon.png | 1,094 KB | <200 KB | 1024x1024 |
| splash-icon.png | 1,313 KB | <200 KB | 2048x2048 max |

## Why Optimize?

- **App Store Limits**: iOS apps over 200MB require Wi-Fi download
- **User Experience**: Large assets slow app launch
- **Memory**: Large images cause OOM crashes on low-end devices
- **Bandwidth**: Impacts users on limited data plans

## Compression Options

### Option 1: Automated (Recommended)

Install Sharp and run the compression script:

```bash
# Install sharp
npm install --save-dev sharp

# Run compression
node compress-assets.js
```

### Option 2: Manual (TinyPNG)

1. Go to https://tinypng.com/
2. Upload each PNG image
3. Download the compressed versions
4. Replace files in `assets/` folder

### Option 3: Figma/Design Tool

Export from design tool with these settings:
- Format: PNG
- Quality: 80%
- Icon dimensions: 1024x1024
- Splash dimensions: 2048x2048

## Expected Results After Compression

```
assets/
├── icon.png           (~120 KB)  ✅
├── adaptive-icon.png  (~100 KB)  ✅
├── splash-icon.png    (~180 KB)  ✅
└── favicon.png        (unchanged)
```

## Verification

After compression, verify with:

```bash
# Check file sizes
ls -lh assets/*.png

# Or on Windows
Get-ChildItem assets/*.png | Select-Object Name, @{N="SizeKB";E={[math]::Round($_.Length/1KB,2)}}
```

## EAS Build Configuration

The optimized assets will be automatically included in EAS builds. No additional configuration needed.

## Troubleshooting

### Images Look Blurry
- Increase quality to 85-90%
- Check source image resolution

### Still Too Large
- Reduce dimensions by 50%
- Use JPG for splash (if no transparency needed)

### Build Errors
- Ensure PNG format is preserved
- Check for corrupted files
