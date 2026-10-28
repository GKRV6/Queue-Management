'use strict';

const express = require('express');
const { requireRole } = require('../auth');
const { validate, parseId } = require('../validate');
const queue = require('../services/queueService');
const { getStaffDashboard } = require('../services/staffService');
const { ok } = require('./respond');

module.exports = function staffRoutes(db) {
  const router = express.Router();
  router.use(requireRole('staff'));

  router.get('/dashboard', (req, res) => ok(res, getStaffDashboard(db, req.user.user_id)));

  router.patch('/counter', (req, res) => {
    const { status } = validate(req.body, {
      status: { type: 'enum', values: ['open', 'paused', 'closed'], required: true, label: 'Counter status' },
    });
    ok(res, queue.setCounterStatus(db, req.user.user_id, status));
  });

  router.post('/call-next', (req, res) => {
    const token = queue.callNext(db, req.user.user_id);
    ok(res, { token, message: token ? `Calling ${token.token_code}` : 'No eligible tokens are waiting' });
  });

  const tokenActions = {
    start: (id) => queue.startServing(db, id.user, id.token),
    skip: (id) => queue.skipToken(db, id.user, id.token),
    'no-show': (id) => queue.markNoShow(db, id.user, id.token),
    requeue: (id) => queue.requeueToken(db, id.user, id.token),
    prioritize: (id) => queue.prioritizeToken(db, id.user, id.token),
  };
  for (const [action, run] of Object.entries(tokenActions)) {
    router.post(`/tokens/:id/${action}`, (req, res) => {
      ok(res, run({ user: req.user.user_id, token: parseId(req.params.id) }));
    });
  }

  router.post('/tokens/:id/complete', (req, res) => {
    const input = validate(req.body, { remarks: { type: 'string', max: 300, label: 'Remarks' } });
    ok(res, queue.completeToken(db, req.user.user_id, parseId(req.params.id), { remarks: input.remarks ?? null }));
  });

  router.patch('/queues/:id', (req, res) => {
    const { status } = validate(req.body, {
      status: { type: 'enum', values: ['open', 'paused', 'closed'], required: true, label: 'Queue status' },
    });
    ok(res, queue.setQueueStatus(db, req.user, parseId(req.params.id), status));
  });

  return router;
};
