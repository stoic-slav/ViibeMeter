import { AppRegistry } from 'react-native';
import { SESSION_TASK_NAME, sessionTask } from './modules/session-service';
import 'expo-router/entry';

// Android: the session foreground service runs this task to keep JS timers alive in the background
AppRegistry.registerHeadlessTask(SESSION_TASK_NAME, () => sessionTask);
