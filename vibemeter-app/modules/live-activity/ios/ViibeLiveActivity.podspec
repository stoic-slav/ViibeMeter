Pod::Spec.new do |s|
  s.name           = 'ViibeLiveActivity'
  s.version        = '1.0.0'
  s.summary        = 'Lock-screen Live Activity for a running session, with rating buttons'
  s.license        = 'MIT'
  s.author         = 'ViibeMeter'
  s.homepage       = 'https://github.com/stoic-slav/ViibeMeter'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.weak_frameworks = 'ActivityKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
