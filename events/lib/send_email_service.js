'use strict';

import { debug } from './index';
import * as async from 'async';
import { SES, SNS } from 'aws-sdk';

class SendEmailService {

  constructor(queue, lambdaClient, context) {
    this.queue = queue;
    this.emailClient = null;
    this.sns = null;
    this.lambdaClient = lambdaClient;
    this.lambdaName = context.functionName;
    this.context = context;
    this.counter = 0;
  }

  get executionThreshold() {
    return 60000;
  }

  sendEnqueuedEmails() {
    return this.sendBatch()
      .then((batch) => this.deleteBatch(batch))
      .then(() => this.sendNextBatch())
      .catch(err => debug('= SendEmailService.sendEnqueuedEmails', `Sent ${this.counter} emails so far`));
  }

  sendNextBatch() {
    if (this.timeEnough()) {
      debug('= SendEmailService.sendNextBatch', 'Time enough for another batch');
      return this.sendEnqueuedEmails();
    } else {
      debug('= SendEmailService.sendNextBatch', 'Not time enough for next batch, invoking lambda...');
      return this.invokeLambda();
    }
  }

  invokeLambda() {
    return new Promise((resolve, reject) => {
      debug('= SendEmailService.invokeLambda', 'Invoking function again', this.lambdaName);
      const payload = { QueueUrl: this.queue.url };
      const params = {
        FunctionName: this.lambdaName,
        InvocationType: 'Event',
        Payload: JSON.stringify(payload)
      };
      this.lambdaClient.invoke(params, (err, data) => {
        if (err) {
          debug('= SendEmailService.invokeLambda', 'Error invoking lambda', err, err.stack);
          reject(err);
        } else {
          debug('= SendEmailService.invokeLambda', 'Invoked successfully');
          resolve(data);
        }
      });
    });
  }

  timeEnough() {
    return (this.context.getRemainingTimeInMillis() > this.executionThreshold);
  }

  sendBatch() {
    debug('= SendEmailService.sendBatch', 'Sending batch...');
    return new Promise((resolve, reject) => {
      const sentEmailsHandles = [];
      const sentEmails = [];
      this.queue.retrieveMessages()
        .then((enqueuedEmails) => {
          debug('= SendEmailService.sendBatch', 'Got', enqueuedEmails.length, 'messages');
          this.setEmailClient(enqueuedEmails[0]);
          async.each(enqueuedEmails, (email, callback) => {
            this.deliver(email)
              .then((result) => {
                sentEmailsHandles.push({
                  ReceiptHandle: email.receiptHandle,
                  Id: email.messageId
                });
                sentEmails.push(email.toSentEmail(result.MessageId));
                callback();
              }).catch(err => {
                debug('= SendEmailService.sendBatch', 'Error', err);
                if (this._isAbortError(err)) {
                  debug('= SendEmailService.sendBatch', 'Aborting...');
                  this._publishSentEmails(sentEmails, () => reject(err));
                } else if (this._isRetryableError(err)) {
                  debug('= SendEmailService.sendBatch', 'Retry');
                  callback();
                } else {
                  debug('= SendEmailService.sendBatch', 'Removing from queue', err);
                  sentEmailsHandles.push({
                    ReceiptHandle: email.receiptHandle,
                    Id: email.messageId
                  });
                  callback();
                }
              });
          }, () => {
            this._publishSentEmails(sentEmails, () => resolve(sentEmailsHandles));
          });
        })
        .catch(() => debug('= SendEmailService.sendBatch', `Sent ${this.counter} emails so far`));
    });
  }

  _publishSentEmails(sentEmails, callback) {
    const snsParams = {
      Message: JSON.stringify(sentEmails),
      TopicArn: process.env.SENT_EMAILS_TOPIC_ARN
    };
    return this.snsClient.publish(snsParams, callback);
  }

  _isAbortError(error) {
    debug('= SendEmailService._isAbortError', error);
    return error.code && error.code === 'MessageRejected' ||
      (error.code === 'Throttling' && !!error.message.toLowerCase().match('daily message quota exceeded'));
  }

  _isRetryableError(error) {
    debug('= SendEmailService._isRetryableError', error);
    return error.code && error.code === 'Throttling' && !!error.message.toLowerCase().match('maximum sending rate exceeded');
  }

  deleteBatch(batch) {
    debug('= SendEmailService.deleteBatch', `Deleting a batch of ${batch.length} messages`);
    return this.queue.removeMessages(batch);
  }

  deliver(enqueuedEmail) {
    debug('= SendEmailService.deliver', 'Sending email', enqueuedEmail.receiptHandle);
    return enqueuedEmail.toSesRawParams()
      .then(params => this._deliverRawEmail(params));
  }

  _deliverRawEmail(params) {
    return new Promise((resolve, reject) => {
      this.emailClient.sendRawEmail(params, (err, data) => {
        if (err) {
          debug('= SendEmailService.deliver', 'Error sending email', err, err.stack);
          reject(err);
        } else {
          debug('= SendEmailService.deliver', 'Email sent');
          this.counter++;
          resolve(data);
        }
      });
    });
  }

  get snsClient() {
    debug('= SendEmailService.snsClient', 'Getting SNS client');
    if (!this.sns) {
      this.sns = new SNS({region: process.env.SERVERLESS_REGION || 'us-east-1'});
    }
    return this.sns;
  }

  setEmailClient(enqueuedEmail) {
    debug('= SendEmailService.setEmailClient', 'Getting client');
    if (!this.emailClient) {
      debug('= SendEmailService.setEmailClient', 'Non existing client. Building one...');
      this.emailClient = new SES(this._sesClientParams(enqueuedEmail));
      return this.emailClient;
    }
  }

  _sesClientParams(enqueuedEmail) {
    debug('= SendEmailService._sesClientParams', JSON.stringify(enqueuedEmail.message.sender));
    return {
      accessKeyId: enqueuedEmail.message.sender.apiKey,
      secretAccessKey: enqueuedEmail.message.sender.apiSecret,
      region: enqueuedEmail.message.sender.region
    };
  }
}

module.exports.SendEmailService = SendEmailService;
