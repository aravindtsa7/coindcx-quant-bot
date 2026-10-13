'use strict';
// Pure synthetic fixture construction; no file access, startup, credentials or initialization.
const path = require('node:path'), { createHash } = require('node:crypto');
function makeOfflinePrepareFixture(input, parent) {
  if (typeof parent !== 'string' || !path.isAbsolute(parent)
    || !input?.accountMapping?.accountId?.startsWith('OFFLINE-')
    || input.accountMapping.sourceReference !== 'SYNTHETIC_ONLY_NOT_ACCOUNT_EVIDENCE'
    || input.credentialProvenance?.sourceReference !== 'SYNTHETIC_ONLY_NO_CREDENTIALS'
    || input.credentialProvenance.sourceBinding) throw Error('SYNTHETIC_PREPARE_FIXTURE_REQUIRED');
  const value = structuredClone(input);
  const campaignId = 'readonly-campaign-OFFLINE-prepare-diagnostic';
  const installationId = 's' + createHash('sha256').update(path.resolve(parent)).digest('hex').slice(0, 32);
  value.host.campaignId = campaignId; value.host.installationId = installationId;
  value.host.coordinator.stateDirectory = path.join(parent, campaignId);
  value.host.coordinator.pipePath = value.host.client.pipePath = `\\\\.\\pipe\\coindcx-readonly-campaign-${installationId}`;
  value.host.reportDirectory = path.join(value.host.coordinator.stateDirectory, 'reports');
  value.proposal.configuration.reportDestination.path = path.join(value.host.reportDirectory, 'campaign-report.json');
  value.managedTraffic.knownConsumers = [{ consumerId: campaignId, coordinatorInstallationId: installationId, operations: 'READ_P1_API_AUTH' }];
  return value;
}
module.exports = { makeOfflinePrepareFixture };
