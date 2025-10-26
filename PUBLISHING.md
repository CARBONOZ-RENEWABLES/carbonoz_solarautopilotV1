# Publishing CARBONOZ SolarAutopilot Add-on

## Pre-built Container Publishing Steps

### 1. Build and Push Container Images
```bash
# Trigger the GitHub Action to build multi-architecture images
git push origin main
# Or manually trigger via GitHub Actions UI
```

### 2. Verify Images are Built
Check that these images exist in GitHub Container Registry:
- `ghcr.io/elitedesire/carbonoz_solarautopilot:1.0.0-amd64`
- `ghcr.io/elitedesire/carbonoz_solarautopilot:1.0.0-aarch64`
- `ghcr.io/elitedesire/carbonoz_solarautopilot:1.0.0-armhf`
- `ghcr.io/elitedesire/carbonoz_solarautopilot:1.0.0-armv7`
- `ghcr.io/elitedesire/carbonoz_solarautopilot:1.0.0-i386`

### 3. Create Add-on Repository
1. Create a new repository for your add-on store
2. Add this add-on as a subdirectory
3. Include `repository.yaml` in the root

### 4. Test Installation
1. Add your repository URL to Home Assistant
2. Install the add-on from the store
3. Verify all architectures work correctly

## Files Modified for Pre-built Publishing:
- `build.yaml` - Updated to reference pre-built images
- `config.yaml` - Added image reference
- `.github/workflows/build.yml` - Multi-architecture build
- `Dockerfile.prebuilt` - Minimal Dockerfile for pre-built containers
- `repository.yaml` - Repository configuration