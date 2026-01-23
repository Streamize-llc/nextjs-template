import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

interface TestSummary {
  title: string;
  file: string;
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';
  duration: number;
}

class SummaryReporter implements Reporter {
  private results: TestSummary[] = [];
  private startTime: number = 0;

  onBegin(_config: FullConfig, _suite: Suite) {
    this.startTime = Date.now();
    this.results = [];
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const file = test.location.file.split('/').slice(-2).join('/');
    this.results.push({
      title: test.title,
      file,
      status: result.status,
      duration: result.duration,
    });
  }

  onEnd(result: FullResult) {
    const totalDuration = Date.now() - this.startTime;

    console.log('\n');
    console.log('═'.repeat(70));
    console.log('  📊 TEST RESULTS SUMMARY');
    console.log('═'.repeat(70));
    console.log('');

    // Group by file
    const byFile = this.results.reduce(
      (acc, test) => {
        if (!acc[test.file]) acc[test.file] = [];
        acc[test.file].push(test);
        return acc;
      },
      {} as Record<string, TestSummary[]>
    );

    for (const [file, tests] of Object.entries(byFile)) {
      console.log(`  📁 ${file}`);
      console.log('  ' + '─'.repeat(66));

      for (const test of tests) {
        const icon = this.getStatusIcon(test.status);
        const status = this.getStatusText(test.status);
        const duration = this.formatDuration(test.duration);

        console.log(`     ${icon} ${test.title}`);
        console.log(`        Status: ${status}  |  Duration: ${duration}`);
      }
      console.log('');
    }

    // Summary stats
    const passed = this.results.filter((t) => t.status === 'passed').length;
    const failed = this.results.filter((t) => t.status === 'failed').length;
    const skipped = this.results.filter((t) => t.status === 'skipped').length;
    const total = this.results.length;

    console.log('═'.repeat(70));
    console.log('  📈 FINAL SUMMARY');
    console.log('═'.repeat(70));
    console.log('');
    console.log(`     Total Tests:  ${total}`);
    console.log(`     ✅ Passed:    ${passed}`);
    console.log(`     ❌ Failed:    ${failed}`);
    console.log(`     ⏭️  Skipped:   ${skipped}`);
    console.log('');
    console.log(`     ⏱️  Total Time: ${this.formatDuration(totalDuration)}`);
    console.log(`     📋 Status:    ${result.status.toUpperCase()}`);
    console.log('');
    console.log('═'.repeat(70));
    console.log('');
  }

  private getStatusIcon(status: TestSummary['status']): string {
    switch (status) {
      case 'passed':
        return '✅';
      case 'failed':
        return '❌';
      case 'skipped':
        return '⏭️';
      case 'timedOut':
        return '⏰';
      case 'interrupted':
        return '🛑';
      default:
        return '❓';
    }
  }

  private getStatusText(status: TestSummary['status']): string {
    switch (status) {
      case 'passed':
        return 'PASSED';
      case 'failed':
        return 'FAILED';
      case 'skipped':
        return 'SKIPPED';
      case 'timedOut':
        return 'TIMEOUT';
      case 'interrupted':
        return 'INTERRUPTED';
      default:
        return 'UNKNOWN';
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(1);
      return `${minutes}m ${seconds}s`;
    }
  }
}

export default SummaryReporter;
