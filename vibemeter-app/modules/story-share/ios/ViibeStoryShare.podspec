Pod::Spec.new do |s|
  s.name           = 'ViibeStoryShare'
  s.version        = '1.0.0'
  s.summary        = 'Shares the night recap card straight to an Instagram Story'
  s.license        = 'MIT'
  s.author         = 'ViibeMeter'
  s.homepage       = 'https://github.com/stoic-slav/ViibeMeter'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
