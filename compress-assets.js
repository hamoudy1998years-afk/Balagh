#!/usr/bin/env node
/**
 * Asset Compression Script for Bushrann
 * 
 * This script compresses icon and splash assets to production-ready sizes.
 * Run: node compress-assets.js
 */

const fs = require('fs');
const path = require('path');

// Check if sharp is installed
try {
  const sharp = require('sharp');
  
  const ASSETS_DIR = './assets';
  
  const assets = [
    {
      file: 'icon.png',
      targetWidth: 1024,
      targetHeight: 1024,
      quality: 80,
      maxSizeKB: 200
    },
    {
      file: 'adaptive-icon.png',
      targetWidth: 1024,
      targetHeight: 1024,
      quality: 80,
      maxSizeKB: 200
    },
    {
      file: 'splash-icon.png',
      targetWidth: 2048,
      targetHeight: 2048,
      quality: 75,
      maxSizeKB: 200
    }
  ];

  async function compressAsset(asset) {
    const inputPath = path.join(ASSETS_DIR, asset.file);
    const backupPath = path.join(ASSETS_DIR, `${asset.file}.backup`);
    const tempOutput = path.join(ASSETS_DIR, `temp-${asset.file}`);
    
    // Check if file exists
    if (!fs.existsSync(inputPath)) {
      if (process.env.NODE_ENV !== 'production') console.log(`⚠️  Skipping ${asset.file} - file not found`);
      return;
    }
    
    const originalSize = fs.statSync(inputPath).size;
    const originalSizeKB = (originalSize / 1024).toFixed(2);
    
    if (process.env.NODE_ENV !== 'production') {
      console.log(`\n📷 Processing ${asset.file}...`);
      console.log(`   Original size: ${originalSizeKB} KB`);
    }
    
    // Create backup
    fs.copyFileSync(inputPath, backupPath);
    
    try {
      await sharp(inputPath)
        .resize(asset.targetWidth, asset.targetHeight, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .png({
          quality: asset.quality,
          compressionLevel: 9,
          adaptiveFiltering: true
        })
        .toFile(tempOutput);
      
      const newSize = fs.statSync(tempOutput).size;
      const newSizeKB = (newSize / 1024).toFixed(2);
      const savings = ((originalSize - newSize) / originalSize * 100).toFixed(1);
      
      // Replace original with compressed
      fs.renameSync(tempOutput, inputPath);
      
      if (process.env.NODE_ENV !== 'production') console.log(`   ✅ Compressed to: ${newSizeKB} KB (${savings}% reduction)`);
      
      if (newSizeKB > asset.maxSizeKB) {
        if (process.env.NODE_ENV !== 'production') console.log(`   ⚠️  Warning: Still over ${asset.maxSizeKB}KB target`);
      }
      
      // Remove backup on success
      fs.unlinkSync(backupPath);
      
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') console.log(`   ❌ Error: ${error.message}`);
      // Restore backup
      if (fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, inputPath);
        if (process.env.NODE_ENV !== 'production') console.log(`   🔄 Restored backup`);
      }
      if (fs.existsSync(tempOutput)) {
        fs.unlinkSync(tempOutput);
      }
    }
  }

  async function main() {
    if (process.env.NODE_ENV !== 'production') console.log('🚀 Asset Compression Tool\n');
    
    for (const asset of assets) {
      await compressAsset(asset);
    }
    
    if (process.env.NODE_ENV !== 'production') {
      console.log('\n✨ Done!');
      console.log('\n📊 Summary:');
      console.log('   Backup files (.backup) removed after successful compression');
      console.log('   If anything went wrong, check for .backup files');
    }
  }

  main().catch(console.error);
  
} catch (e) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('❌ Sharp is not installed. Install it with:');
    console.log('   npm install --save-dev sharp\n');
    console.log('Or use manual compression with TinyPNG:\n');
    console.log('   1. Visit https://tinypng.com/');
    console.log('   2. Upload each image:');
    console.log('      - icon.png (target: 1024x1024, <200KB)');
    console.log('      - adaptive-icon.png (target: 1024x1024, <200KB)');
    console.log('      - splash-icon.png (target: 2048x2048, <200KB)');
    console.log('   3. Download and replace files in assets/ folder\n');
  }
  process.exit(1);
}
