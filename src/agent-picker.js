import { isCancel, Prompt } from '@clack/core';

class AgentPicker extends Prompt {
  constructor(choices, defaults, { input, output }) {
    super({
      input,
      output,
      render() {
        if (this.state === 'cancel') return 'Agent selection canceled.';
        if (this.state === 'submit') {
          const labels = choices.filter(({ agent }) => this.value.includes(agent)).map(({ label }) => label);
          return `Agents selected: ${labels.join(', ') || 'none'}`;
        }

        const rows = choices.map(({ agent, label }, index) => {
          const enabled = this.value.includes(agent);
          return `${this.marker(index)} [${enabled ? '✓' : ' '}] ${label.padEnd(12)} ${enabled ? 'On' : 'Off'}`;
        });
        return [
          '  Which agents should Doomer set up?',
          '',
          ...rows,
          '',
          `${this.marker(choices.length)} ${this.continueLabel()}`,
          '',
          '  ↑↓ Move   Space or Enter toggles an agent',
          '  Enter on Continue confirms',
        ].join('\n');
      },
    }, false);
    this.choices = choices;
    this.value = [...new Set(defaults)];
    this.focus = choices.length;
    this.on('cursor', key => {
      const rows = choices.length + 1;
      if (key === 'up') this.focus = (this.focus + rows - 1) % rows;
      if (key === 'down') this.focus = (this.focus + 1) % rows;
      if (key === 'space') this.toggleAgent();
    });
  }

  marker(index) {
    return index === this.focus ? '  ›' : '   ';
  }

  continueLabel() {
    if (this.value.length === 0) return 'Continue without agent hooks';
    if (this.value.length === this.choices.length && this.choices.length === 2) return 'Continue with both agents';
    const selected = this.choices.filter(({ agent }) => this.value.includes(agent));
    return `Continue with ${selected.map(({ label }) => label).join(' and ')}`;
  }

  toggleAgent() {
    const choice = this.choices[this.focus];
    if (!choice) return;
    this.value = this.value.includes(choice.agent)
      ? this.value.filter(agent => agent !== choice.agent)
      : [...this.value, choice.agent];
  }

  _shouldSubmit() {
    if (this.focus === this.choices.length) return true;
    this.toggleAgent();
    return false;
  }
}

export async function pickAgents(choices, defaults, { input = process.stdin, output = process.stderr } = {}) {
  const result = await new AgentPicker(choices, defaults, { input, output }).prompt();
  return isCancel(result) ? null : result;
}
