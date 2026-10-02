Pod::Spec.new do |s|
  s.name           = 'ShazamMatch'
  s.version        = '1.0.0'
  s.summary        = 'Match a recorded audio file against the Shazam catalog with ShazamKit'
  s.license        = 'MIT'
  s.author         = 'ViibeMeter'
  s.homepage       = 'https://github.com/stoic-slav/ViibeMeter'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ShazamKit', 'AVFoundation'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
