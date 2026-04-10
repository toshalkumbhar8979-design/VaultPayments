'use strict';

/**
 * NexusPay — Transaction State Machine
 * 
 * Deterministic lifecycle management for payments. No payment can
 * skip states or enter invalid transitions. Every transition is
 * audit-logged and triggers side effects (ledger, webhooks, metrics).
 * 
 * States:
 *   CREATED → PROCESSING → AUTHORIZED → CAPTURED → SETTLED
 *                                ↓             ↓
 *                              VOIDED       REFUNDED / PARTIALLY_REFUNDED
 *              ↓
 *           FAILED / DECLINED / EXPIRED / CANCELLED
 * 
 * Concurrency: Uses optimistic locking via `version` column.
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ── Valid State Transitions ─────────────────────────────────────────────────

const TRANSITIONS = {
  created:              ['processing', 'expired', 'cancelled'],
  processing:           ['authorized', 'captured', 'failed', 'declined'],
  authorized:           ['captured', 'voided', 'expired'],
  captured:             ['settled', 'refunded', 'partially_refunded'],
  settled:              ['refunded', 'partially_refunded'],
  partially_refunded:   ['refunded', 'settled'],
  // Terminal states — no further transitions
  voided:               [],
  failed:               [],
  declined:             [],
  expired:              [],
  cancelled:            [],
  refunded:             [],
};

// ── Side Effect Definitions ─────────────────────────────────────────────────

const SIDE_EFFECTS = {
  'processing→authorized': ['log_state_change'],
  'processing→captured':   ['log_state_change', 'record_ledger_capture', 'send_webhook_captured'],
  'authorized→captured':   ['log_state_change', 'record_ledger_capture', 'send_webhook_captured'],
  'captured→settled':      ['log_state_change', 'send_webhook_settled'],
  'captured→refunded':     ['log_state_change', 'record_ledger_refund', 'send_webhook_refunded'],
  'settled→refunded':      ['log_state_change', 'record_ledger_refund', 'send_webhook_refunded'],
  'processing→failed':     ['log_state_change', 'send_webhook_failed'],
  'processing→declined':   ['log_state_change', 'send_webhook_failed'],
  'authorized→voided':     ['log_state_change', 'send_webhook_voided'],
  'created→expired':       ['log_state_change'],
  'created→cancelled':     ['log_state_change'],
  'authorized→expired':    ['log_state_change'],
};

// ── State Machine Class ─────────────────────────────────────────────────────

class PaymentStateMachine {
  constructor({ db, ledgerService, webhookDispatcher, pgQuery } = {}) {
    this.db = db;                        // SQLite getDb()
    this.ledger = ledgerService;         // ledger.service.js
    this.webhooks = webhookDispatcher;   // webhook-dispatcher.js
    this.pgQuery = pgQuery;              // pg.database.query
  }

  /**
   * Attempt a state transition for a payment.
   * 
   * @param {string} paymentId - Payment ID
   * @param {string} targetState - Desired next state
   * @param {Object} context - { actor, trigger, metadata }
   * @returns {Object} { success, payment, previousState, newState }
   * @throws If transition is invalid or concurrent modification detected
   */
  async transition(paymentId, targetState, context = {}) {
    const { actor = 'system', trigger = '', metadata = {} } = context;
    const normalizedTarget = targetState.toLowerCase();

    // 1. Fetch current payment state from SQLite
    const payment = await this.db.get('SELECT * FROM payments WHERE id = ?', [paymentId]);
    if (!payment) {
      throw new Error(`Payment ${paymentId} not found`);
    }

    const currentState = payment.status.toLowerCase();

    // 2. Validate transition
    if (!this.isValidTransition(currentState, normalizedTarget)) {
      throw new TransitionError(
        `Invalid transition: ${currentState} → ${normalizedTarget}. ` +
        `Valid targets: [${(TRANSITIONS[currentState] || []).join(', ')}]`,
        currentState,
        normalizedTarget
      );
    }

    // 3. Update payment state with optimistic locking
    const now = new Date().toISOString();
    const updateFields = { status: normalizedTarget, updated_at: now };

    // Set timestamp fields based on target state
    if (normalizedTarget === 'captured')  updateFields.captured_at = now;
    if (normalizedTarget === 'refunded')  updateFields.refunded_at = now;

    const setClause = Object.keys(updateFields).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updateFields), paymentId, currentState];

    const result = await this.db.run(
      `UPDATE payments SET ${setClause} WHERE id = ? AND status = ?`,
      values
    );

    if (result.changes === 0) {
      throw new TransitionError(
        `Concurrent modification: payment ${paymentId} changed state since read`,
        currentState,
        normalizedTarget
      );
    }

    // 4. Log state change to PostgreSQL audit trail
    await this.logStateChange(paymentId, currentState, normalizedTarget, trigger, actor, metadata);

    // 5. Execute side effects
    const transitionKey = `${currentState}→${normalizedTarget}`;
    const effects = SIDE_EFFECTS[transitionKey] || ['log_state_change'];

    for (const effect of effects) {
      try {
        await this.executeSideEffect(effect, payment, currentState, normalizedTarget, context);
      } catch (err) {
        // Side effects should not fail the transition
        logger.error(`[STATE_MACHINE] Side effect '${effect}' failed for ${paymentId}: ${err.message}`);
      }
    }

    logger.info(`[STATE_MACHINE] ${paymentId}: ${currentState} → ${normalizedTarget} (trigger: ${trigger || 'none'})`);

    return {
      success: true,
      paymentId,
      previousState: currentState,
      newState: normalizedTarget,
      transitionedAt: now,
    };
  }

  /**
   * Check if a transition is valid without executing it.
   */
  isValidTransition(fromState, toState) {
    const validTargets = TRANSITIONS[fromState.toLowerCase()];
    if (!validTargets) return false;
    return validTargets.includes(toState.toLowerCase());
  }

  /**
   * Get all valid next states for a given state.
   */
  getValidTransitions(fromState) {
    return TRANSITIONS[fromState.toLowerCase()] || [];
  }

  /**
   * Check if a state is terminal (no further transitions possible).
   */
  isTerminal(state) {
    const targets = TRANSITIONS[state.toLowerCase()];
    return !targets || targets.length === 0;
  }

  // ── Side Effect Handlers ───────────────────────────────────────────────

  async executeSideEffect(effect, payment, fromState, toState, context) {
    switch (effect) {
      case 'log_state_change':
        // Already handled in logStateChange()
        break;

      case 'record_ledger_capture':
        if (this.ledger) {
          const feeCalc = require('../services/fee-calculator');
          const fees = feeCalc.calculate(payment.amount, payment.payment_method, payment.currency);
          
          await this.ledger.recordPaymentCapture({
            paymentId: payment.id,
            merchantId: payment.merchant_id,
            grossAmount: payment.amount,
            feeAmount: fees.feeAmount,
            gstOnFee: fees.gstOnFee,
            currency: payment.currency,
            idempotencyKey: `capture_${payment.id}`,
          });

          // Update payment with fee info in SQLite
          await this.db.run(
            `UPDATE payments SET gateway_fee = ?, net_amount = ? WHERE id = ?`,
            [fees.feeAmount + fees.gstOnFee, fees.netAmount, payment.id]
          );
        }
        break;

      case 'record_ledger_refund':
        if (this.ledger) {
          await this.ledger.recordRefund({
            paymentId: payment.id,
            merchantId: payment.merchant_id,
            refundAmount: payment.net_amount || payment.amount,
            currency: payment.currency,
            idempotencyKey: `refund_${payment.id}_${Date.now()}`,
          });
        }
        break;

      case 'send_webhook_captured':
        if (this.webhooks) {
          await this.webhooks.dispatch(payment.merchant_id, 'payment.captured', {
            payment_id: payment.id,
            order_id: payment.order_id,
            amount: payment.amount,
            currency: payment.currency,
            status: 'captured',
          });
        }
        break;

      case 'send_webhook_settled':
        if (this.webhooks) {
          await this.webhooks.dispatch(payment.merchant_id, 'payment.settled', {
            payment_id: payment.id,
            order_id: payment.order_id,
            amount: payment.amount,
            status: 'settled',
          });
        }
        break;

      case 'send_webhook_refunded':
        if (this.webhooks) {
          await this.webhooks.dispatch(payment.merchant_id, 'payment.refunded', {
            payment_id: payment.id,
            order_id: payment.order_id,
            amount: payment.amount,
            status: 'refunded',
          });
        }
        break;

      case 'send_webhook_failed':
        if (this.webhooks) {
          await this.webhooks.dispatch(payment.merchant_id, 'payment.failed', {
            payment_id: payment.id,
            order_id: payment.order_id,
            amount: payment.amount,
            status: 'failed',
          });
        }
        break;

      case 'send_webhook_voided':
        if (this.webhooks) {
          await this.webhooks.dispatch(payment.merchant_id, 'payment.voided', {
            payment_id: payment.id,
            order_id: payment.order_id,
            status: 'voided',
          });
        }
        break;
    }
  }

  // ── Audit Trail ────────────────────────────────────────────────────────

  async logStateChange(paymentId, fromState, toState, trigger, actor, metadata) {
    try {
      if (this.pgQuery) {
        await this.pgQuery(
          `INSERT INTO payment_state_log (payment_id, from_state, to_state, trigger, actor, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [paymentId, fromState, toState, trigger, actor, JSON.stringify(metadata)]
        );
      }
    } catch (err) {
      // Audit logging failure should not block the transition
      logger.warn(`[STATE_MACHINE] Audit log failed for ${paymentId}: ${err.message}`);
    }
  }

  /**
   * Get full transition history for a payment.
   */
  async getHistory(paymentId) {
    if (!this.pgQuery) return [];
    try {
      const result = await this.pgQuery(
        `SELECT * FROM payment_state_log WHERE payment_id = $1 ORDER BY created_at ASC`,
        [paymentId]
      );
      return result.rows;
    } catch {
      return [];
    }
  }
}

// ── Custom Error ────────────────────────────────────────────────────────────

class TransitionError extends Error {
  constructor(message, fromState, toState) {
    super(message);
    this.name = 'TransitionError';
    this.fromState = fromState;
    this.toState = toState;
  }
}

module.exports = { PaymentStateMachine, TransitionError, TRANSITIONS };
