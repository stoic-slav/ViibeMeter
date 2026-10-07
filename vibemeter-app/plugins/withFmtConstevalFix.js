// Xcode 26's Apple clang fails to compile fmt's consteval format strings (React Native's
// bundled fmt 11). The local ios/ folder has this patched by hand; builds from a fresh prebuild
// (`eas build --local` on this Mac with Xcode 26) need it too. This adds a post_install step to
// the Podfile that tells fmt that consteval is broken in Apple clang, as newer fmt releases do.
// Harmless on older Xcode versions.
const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '# withFmtConstevalFix';
const SNIPPET = `
    ${MARKER}
    fmt_base = File.join(installer.sandbox.root.to_s, 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base)
      fmt_src = File.read(fmt_base)
      unless fmt_src.include?('consteval is broken in Apple clang')
        fmt_src = fmt_src.sub('#elif FMT_MSC_VERSION && FMT_MSC_VERSION < 1929',
          "#elif defined(__apple_build_version__)\\n#  define FMT_USE_CONSTEVAL 0  // consteval is broken in Apple clang (all versions).\\n#elif FMT_MSC_VERSION && FMT_MSC_VERSION < 1929")
        File.chmod(0644, fmt_base) rescue nil
        File.write(fmt_base, fmt_src)
      end
    end
`;

module.exports = function withFmtConstevalFix(config) {
  return withDangerousMod(config, ['ios', async cfg => {
    const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
    let src = fs.readFileSync(podfile, 'utf8');
    if (!src.includes(MARKER)) {
      src = src.replace(/post_install do \|installer\|\n/, match => match + SNIPPET);
      fs.writeFileSync(podfile, src);
    }
    return cfg;
  }]);
};
