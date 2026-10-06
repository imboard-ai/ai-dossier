import { describe, expect, it } from 'vitest';
import { MAX_REPORT_BYTES } from '../vm/adapter';
import { classifyOutcome } from './classify';
import { parseJunitReport } from './report';

const xml = (body: string) => Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n${body}`);

describe('parseJunitReport', () => {
  it("reads node's junit reporter, whose test cases may sit directly under <testsuites>", () => {
    const report = xml(`<testsuites>
	<testcase name="parses 90s" time="0.001" classname="test"/>
	<testcase name="regression" time="0.002" classname="test" failure="x">
		<failure type="testCodeFailure" message="x">boom</failure>
	</testcase>
	<!-- suites 0 -->
</testsuites>`);
    expect(parseJunitReport(report)).toEqual({ suites: 1, tests: 2, failures: 1, skipped: 0 });
  });

  it('reads pytest --junitxml output', () => {
    const report = xml(
      '<testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" skipped="1" tests="3">' +
        '<testcase classname="tests.test_slug" name="test_a" time="0.001" />' +
        '<testcase classname="tests.test_slug" name="test_b" time="0.001"><skipped message="x" /></testcase>' +
        '<testcase classname="tests.test_slug" name="test_c" time="0.001"><error message="e" /></testcase>' +
        '</testsuite></testsuites>'
    );
    expect(parseJunitReport(report)).toEqual({ suites: 1, tests: 3, failures: 1, skipped: 1 });
  });

  it('counts nested suites that hold cases, and a failure outranks a skip', () => {
    const report = xml(
      '<testsuites><testsuite name="outer"><testsuite name="inner">' +
        '<testcase name="a"><skipped/><failure message="x"/></testcase>' +
        '</testsuite><testcase name="b"/></testsuite><testsuite name="empty"></testsuite></testsuites>'
    );
    expect(parseJunitReport(report)).toEqual({ suites: 2, tests: 2, failures: 1, skipped: 0 });
  });

  it.each([
    ['unclosed test cases', '<testcase name="x">'],
    ['unclosed suites', '<testsuite name="x">'],
  ])('scans a hostile report linearly (%s)', (_label, unit) => {
    const body = unit.repeat(Math.floor((MAX_REPORT_BYTES - 64) / unit.length));
    const started = performance.now();
    const summary = parseJunitReport(xml(`<testsuites>${body}`));
    // A quadratic scan of this input takes seconds; a linear one, milliseconds.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(summary).not.toBeNull();
  });

  it('counts zero suites when no test case ran, which classifies as inconclusive', () => {
    const empty = parseJunitReport(
      xml('<testsuites><testsuite name="pytest" tests="0"></testsuite></testsuites>')
    );
    expect(empty).toEqual({ suites: 0, tests: 0, failures: 0, skipped: 0 });
    expect(classifyOutcome({ kind: 'exited', exitCode: 0, report: empty })).toBe('inconclusive');
  });

  it.each([
    ['missing', null],
    ['empty', Buffer.alloc(0)],
    ['not junit', Buffer.from('{"tests": 3}')],
    [
      'entity definitions',
      xml('<!DOCTYPE x [<!ENTITY a "b">]><testsuites><testcase name="&a;"/></testsuites>'),
    ],
    ['oversize', Buffer.concat([xml('<testsuites>'), Buffer.alloc(MAX_REPORT_BYTES)])],
  ])('returns null for an unusable report (%s), which is never a pass', (_label, bytes) => {
    expect(parseJunitReport(bytes)).toBeNull();
    expect(classifyOutcome({ kind: 'exited', exitCode: 0, report: null })).toBe('inconclusive');
  });
});
