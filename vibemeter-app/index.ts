import { AppRegistry } from 'react-native';
import { SESSION_TASK_NAME, sessionTask } from './modules/session-service';
import 'expo-router/entry';
// Wires auto-stop and venue updates to the session, whichever screen is open
import './src/session/SessionControl';

// Android: the session foreground service runs this task to keep JS timers alive in the background
AppRegistry.registerHeadlessTask(SESSION_TASK_NAME, () => sessionTask);
