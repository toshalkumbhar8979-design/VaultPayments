'use strict';

/**
 * NexusPay — Rule Evaluation DSL
 * 
 * Evaluates a set of JSON conditions against a context (Payment Intent).
 */

function evaluateCondition(conditions, context) {
  if (!conditions || Object.keys(conditions).length === 0) return true; // Empty rule matches everything

  for (const [key, expected] of Object.entries(conditions)) {
    const actual = context[key];
    
    if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
      // Operator-based condition
      if (expected.eq !== undefined && actual !== expected.eq) return false;
      if (expected.neq !== undefined && actual === expected.neq) return false;
      if (expected.gt !== undefined && actual <= expected.gt) return false;
      if (expected.lt !== undefined && actual >= expected.lt) return false;
      if (expected.gte !== undefined && actual < expected.gte) return false;
      if (expected.lte !== undefined && actual > expected.lte) return false;
      if (expected.in !== undefined && Array.isArray(expected.in) && !expected.in.includes(actual)) return false;
    } else if (Array.isArray(expected)) {
      // Implicit IN list
      if (!expected.includes(actual)) return false;
    } else {
      // Exact match
      if (actual !== expected) return false;
    }
  }
  
  return true;
}

module.exports = {
  evaluateCondition
};
