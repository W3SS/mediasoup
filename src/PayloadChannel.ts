import { Duplex } from 'stream';
// @ts-ignore
import * as netstring from 'netstring';
import { Logger } from './Logger';
import { EnhancedEventEmitter } from './EnhancedEventEmitter';
import { InvalidStateError } from './errors';

const logger = new Logger('PayloadChannel');

// netstring length for a 4194304 bytes payload.
const NS_MESSAGE_MAX_LEN = 4194313;
const NS_PAYLOAD_MAX_LEN = 4194304;

export class PayloadChannel extends EnhancedEventEmitter
{
	// Closed flag.
	private _closed = false;

	// Unix Socket instance for sending messages to the worker process.
	private readonly _producerSocket: Duplex;

	// Unix Socket instance for receiving messages to the worker process.
	private readonly _consumerSocket: Duplex;

	// Buffer for reading messages from the worker.
	private _recvBuffer?: Buffer;

	// Ongoing notification (waiting for its payload).
	private _ongoingNotification?: { targetId: string; event: string; data?: any };

	/**
	 * @private
	 */
	constructor(
		{
			producerSocket,
			consumerSocket
		}:
		{
			producerSocket: any;
			consumerSocket: any;
		})
	{
		super();

		logger.debug('constructor()');

		this._producerSocket = producerSocket as Duplex;
		this._consumerSocket = consumerSocket as Duplex;

		// Read PayloadChannel notifications from the worker.
		this._consumerSocket.on('data', (buffer: Buffer) =>
		{
			if (!this._recvBuffer)
			{
				this._recvBuffer = buffer;
			}
			else
			{
				this._recvBuffer = Buffer.concat(
					[ this._recvBuffer, buffer ],
					this._recvBuffer.length + buffer.length);
			}

			if (this._recvBuffer!.length > NS_PAYLOAD_MAX_LEN)
			{
				logger.error('receiving buffer is full, discarding all data into it');

				// Reset the buffer and exit.
				this._recvBuffer = undefined;

				return;
			}

			while (true) // eslint-disable-line no-constant-condition
			{
				let nsPayload;

				try
				{
					nsPayload = netstring.nsPayload(this._recvBuffer);
				}
				catch (error)
				{
					logger.error(
						'invalid netstring data received from the worker process: %s',
						String(error));

					// Reset the buffer and exit.
					this._recvBuffer = undefined;

					return;
				}

				// Incomplete netstring message.
				if (nsPayload === -1)
					return;

				this._processData(nsPayload);

				// Remove the read payload from the buffer.
				this._recvBuffer =
					this._recvBuffer!.slice(netstring.nsLength(this._recvBuffer));

				if (!this._recvBuffer.length)
				{
					this._recvBuffer = undefined;

					return;
				}
			}
		});

		this._consumerSocket.on('end', () => (
			logger.debug('Consumer PayloadChannel ended by the worker process')
		));

		this._consumerSocket.on('error', (error) => (
			logger.error('Consumer PayloadChannel error: %s', String(error))
		));

		this._producerSocket.on('end', () => (
			logger.debug('Producer PayloadChannel ended by the worker process')
		));

		this._producerSocket.on('error', (error) => (
			logger.error('Producer PayloadChannel error: %s', String(error))
		));
	}

	/**
	 * @private
	 */
	close(): void
	{
		if (this._closed)
			return;

		logger.debug('close()');

		this._closed = true;

		// Remove event listeners but leave a fake 'error' hander to avoid
		// propagation.
		this._consumerSocket.removeAllListeners('end');
		this._consumerSocket.removeAllListeners('error');
		this._consumerSocket.on('error', () => {});

		this._producerSocket.removeAllListeners('end');
		this._producerSocket.removeAllListeners('error');
		this._producerSocket.on('error', () => {});

		// Destroy the socket after a while to allow pending incoming messages.
		setTimeout(() =>
		{
			try { this._producerSocket.destroy(); }
			catch (error) {}
			try { this._consumerSocket.destroy(); }
			catch (error) {}
		}, 200);
	}

	/**
	 * @private
	 */
	notify(
		event: string,
		internal: object,
		data: any | undefined,
		payload: string | Buffer
	): void
	{
		logger.debug('notify() [event:%s]', event);

		if (this._closed)
			throw new InvalidStateError('PayloadChannel closed');

		const notification = { event, internal, data };
		const ns1 = netstring.nsWrite(JSON.stringify(notification));
		const ns2 = netstring.nsWrite(payload);

		if (Buffer.byteLength(ns1) > NS_MESSAGE_MAX_LEN)
			throw new Error('PayloadChannel notification too big');
		else if (Buffer.byteLength(ns2) > NS_MESSAGE_MAX_LEN)
			throw new Error('PayloadChannel payload too big');

		try
		{
			// This may throw if closed or remote side ended.
			this._producerSocket.write(ns1);
		}
		catch (error)
		{
			logger.warn('notify() | sending notification failed: %s', String(error));

			return;
		}

		try
		{
			// This may throw if closed or remote side ended.
			this._producerSocket.write(ns2);
		}
		catch (error)
		{
			logger.warn('notify() | sending payload failed: %s', String(error));

			return;
		}
	}

	private _processData(data: Buffer): void
	{
		if (!this._ongoingNotification)
		{
			let msg;

			try
			{
				msg = JSON.parse(data.toString('utf8'));
			}
			catch (error)
			{
				logger.error(
					'received invalid data from the worker process: %s',
					String(error));

				return;
			}

			if (!msg.targetId || !msg.event)
			{
				logger.error('received message is not a notification');

				return;
			}

			this._ongoingNotification =
			{
				targetId : msg.targetId,
				event    : msg.event,
				data     : msg.data
			};
		}
		else
		{
			const payload = data as Buffer;

			// Emit the corresponding event.
			this.emit(
				this._ongoingNotification.targetId,
				this._ongoingNotification.event,
				this._ongoingNotification.data,
				payload);

			// Unset ongoing notification.
			this._ongoingNotification = undefined;
		}
	}
}
