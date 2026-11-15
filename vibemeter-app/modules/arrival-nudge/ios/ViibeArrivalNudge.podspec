Pod::Spec.new do |s|
  s.name           = 'ViibeArrivalNudge'
  s.version        = '1.0.0'
  s.summary        = 'Arrival nudges: the system shows "Start measuring?" when the phone enters a club (location-triggered notifications)'
  s.license        = 'MIT'
  s.author         = 'ViibeMeter'
  s.homepage       = 'https://github.com/stoic-slav/ViibeMeter'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreLocation', 'UserNotifications'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
