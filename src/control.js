import readline from 'node:readline/promises';
import { Collaboration } from './core.js';
import { renderStatus } from './display.js';

export async function control(
  root,
  sessionId,
  { input = process.stdin, output = process.stdout } = {},
) {
  const collab = new Collaboration(root);
  const terminal = readline.createInterface({ input, output, terminal: Boolean(output.isTTY) });
  const help =
    'Commands: status | pause | note <instruction> | resume | stop | help | exit\nSwitch windows: Ctrl-b n. Select peer pane: Ctrl-b o. Detach: Ctrl-b d.\nInterrupt active native work in its own pane before changing files.\n';
  output.write(`Model Collab control\nRepository: ${root}\n${help}`);
  try {
    for await (const line of terminal) {
      const [command, ...parts] = line.trim().split(/\s+/);
      if (!command) continue;
      try {
        const state = await collab.status();
        if (state.session?.id !== sessionId) {
          output.write(
            'This control window belongs to an earlier goal. Exit and run model-collab up again.\n',
          );
          continue;
        }
        if (command === 'exit') break;
        if (command === 'help') {
          output.write(help);
          continue;
        }
        if (command === 'status') {
          output.write(renderStatus(state) + '\n');
          continue;
        }
        const result =
          command === 'pause'
            ? await collab.pause()
            : command === 'resume'
              ? await collab.resume()
              : command === 'stop'
                ? await collab.stop('Stopped from control window')
                : command === 'note'
                  ? await collab.note(parts.join(' '))
                  : null;
        output.write(
          result
            ? `${result.session.status}; context ${result.session.contextVersion}. Resume idle peers by saying "continue collaboration" in their panes.\n`
            : help,
        );
      } catch (error) {
        output.write(`Error: ${error.message}\n`);
      }
    }
  } finally {
    terminal.close();
  }
}
