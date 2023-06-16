const Returning = 'id,ownerid,userid,parentid,reference,folderid,statusid,source,name,estimate,worked,ispriority,isbillable,tags,deadline,attachments,dtcreated,dtupdated,dtparent';

NEWSCHEMA('Tickets', function(schema) {

	function makefilter($, builder) {
		const query = $.query;

		query.date && builder.where('date', query.date);
		query.folderid && builder.where('folderid', query.folderid);

		switch (query.type) {
			case 'pending':
				builder.where("statusid='pending' AND (isprivate=FALSE OR isprivate IS NULL)" + (query.date || query.date2 ? "" : " AND date<=timezone('utc'::text, now())"));
				break;
			case 'review':
				builder.where("statusid='review' AND (isprivate=FALSE OR isprivate IS NULL)");
				break;
			case 'note':
				builder.where("statusid='note' AND (isprivate=FALSE OR isprivate IS NULL)");
				break;
			case 'all':
				builder.where('(isprivate=FALSE OR isprivate IS NULL)');
				break;
			case 'bookmarks':
				builder.where('a.id IN (SELECT x.ticketid FROM tbl_ticket_bookmark x WHERE x.userid=\'{0}\')'.format($.user.id));
				break;
			case 'unread':
				builder.where("b.isunread=TRUE AND date<=timezone('utc'::text, now())");
				break;
			case 'open':
				builder.where("statusid IN ('pending','open') AND (isprivate=FALSE OR isprivate IS NULL)" + (query.date || query.date2 ? "" : " AND date<=timezone('utc'::text, now())"));
				break;
			case 'inprogress':
				builder.where("statusid='open' AND (isprivate=FALSE OR isprivate IS NULL)" + (query.date || query.date2 ? "" : " AND date<=timezone('utc'::text, now())"));
				break;
			default:
				if (!query.folderid)
					builder.where("statusid IN ('pending','open') AND (isprivate=FALSE OR isprivate IS NULL)" + (query.date || query.date2 ? "" : " AND date<=timezone('utc'::text, now())"));
				break;
		}

		if (query.type === 'review')
			builder.query('a.ownerid={1}'.format(PG_ESCAPE('{' + $.user.id + '}'), PG_ESCAPE($.user.id)));
		else if (!$.user.admin || !query.admin)
			builder.query('(a.ownerid={1} OR a.userid && {0}::_text)'.format(PG_ESCAPE('{' + $.user.id + '}'), PG_ESCAPE($.user.id)));

		var search = query.q;

		if (search) {

			var tags = [];
			var user = '';
			var istag = false;
			var own = false;

			search = search.replace(/#[a-z0-9\-\_]+/g, function(text) {
				istag = true;
				let tag = text.substring(1).trim().slug().replace(/-/g, '');
				for (var m of REPO.tags) {
					if (m.search.indexOf(tag) !== -1)
						tags.push(m.id);
				}
				return '';
			}).trim();

			// Returns nothing, any tag not found
			if (istag && !tags.length)
				tags.push('_');

			search = search.replace(/@.*?(\s|$)/g, function(text) {
				let tmp = text.substring(1).trim();
				if (!tmp || tmp === 'my')
					own = true;
				else
					user = '%' + tmp.toSearch() + '%';
				return '';
			}).trim();

			if (own)
				builder.query("('{0}'=ANY(a.userid) AND ARRAY_LENGTH(a.userid,1)=1) OR ('{0}'=ANY(a.userid) AND ownerid<>'{0}')".format($.user.id));

			if (search)
				builder.or(b => b.search('a.search', search.toSearch()).search('a.id', search));

			if (user)
				builder.query('(SELECT ARRAY_TO_STRING(ARRAY_AGG(search), \',\') FROM tbl_user x WHERE x.id=ANY(a.userid)) ILIKE ' + PG_ESCAPE(user));

			if (tags.length) {
				builder.or(function() {
					for (var m of tags)
						builder.where(PG_ESCAPE(m) + '=ANY(a.tags)');
				});
			}
		}
	}

	schema.action('list', {
		name: 'List of tickets',
		query: 'type:String, q:String, folderid:UID, skip:Number, limit:Number, date:Date, admin:Number',
		public: true,
		action: function($) {
			var builder = DATA.query('SELECT a.id,a.reference,a.parentid,a.ownerid,a.userid,a.folderid,a.folder,a.folder_color,a.folder_icon,a.statusid,a.name,a.estimate,a.date,a.dtupdated,a.ispriority,a.attachments,a.deadline,a.tags,a.worked,a.comments,b.isunread FROM view_ticket a LEFT JOIN tbl_ticket_unread b ON b.id=(a.id||\'{0}\')'.format($.user.id));
			var query = $.query;
			makefilter($, builder);
			builder.sort('sortindex');
			builder.sort('ispriority', true);
			builder.sort('date', true);
			builder.sort('a.dtcreated', true);
			builder.skip(query.skip || 0);
			builder.take(query.limit || 10);
			builder.callback($);
		}
	});

	schema.action('calendar', {
		name: 'Count of tickets according dates',
		query: 'type:String, folderid:UID, date:Date, admin:Number',
		public: true,
		action: function($) {
			var date = $.query.date || NOW;
			$.query.date = null;
			$.query.date2 = 1;
			var builder = DATA.query('SELECT COUNT(1)::int4 AS count, a.date FROM view_ticket a LEFT JOIN tbl_ticket_unread b ON b.id=(a.id||\'{0}\') {where} GROUP BY date'.format($.user.id));
			makefilter($, builder);
			date.setHours(12);
			date.setDate(1);
			var a = date.add('-1 month');
			var b = date.add('2 month');
			builder.between('a.date', a, b);
			builder.callback($);
		}
	});

	schema.action('read', {
		name: 'Read ticket',
		params: '*id:String',
		public: true,
		action: async function($) {

			var params = $.params;
			var builder = DATA.query('SELECT a.*, b.isunread FROM view_ticket a LEFT JOIN tbl_ticket_unread b ON b.id=(a.id||\'{0}\')'.format($.user.id));

			builder.where('a.id', params.id);

			if (!$.user.sa || $.user.permissions.includes('admin'))
				builder.query('((a.userid && {0}::_text) OR ownerid={1})'.format(PG_ESCAPE('{' + $.user.id + '}'), PG_ESCAPE($.user.id)));

			builder.first();
			builder.error('@(Ticket not found)');

			var response = await builder.promise($);
			$.callback(response);

			if (response.isunread)
				DATA.modify('tbl_ticket_unread', { isunread: false }).id(params.id + $.user.id);

		}
	});

	schema.action('create', {
		name: 'Create ticket',
		input: '*name:String, folderid:UID, userid:[String], ispriority:Boolean, isbillable:Boolean, source:String, tags:[String], html:String, reference:String, date:Date, worked:Number',
		public: true,
		action: async function($, model) {

			var keys = Object.keys(model);

			NOW = new Date();

			model.id = UID();
			model.ownerid = $.user.id;

			if (!model.userid)
				model.userid = [];

			model.statusid = 'pending';
			model.search = model.name.toSearch();

			keys.unshift('id');

			if (!model.folderid)
				model.folderid = null;

			if (!model.date)
				model.date = NOW;

			keys.push('date');

			if (!model.tags)
				model.tags = [];

			model.attachments = '[]';

			var response = await DATA.insert('tbl_ticket', model).returning(Returning).promise($);

			if (model.worked) {
				var logwork = {};
				logwork.id = UID();
				logwork.ticketid = model.id;
				logwork.userid = $.user.id;
				logwork.minutes = model.worked;
				logwork.date = NOW;
				logwork.dtcreated = NOW;
				await DATA.insert('tbl_ticket_time', logwork).promise($);
			}

			var filter = client => response.ownerid === client.user.id || response.userid.includes(client.user.id);

			if (response.userid.length) {
				var users = await DATA.find('tbl_user').fields('id,name').in('id', response.userid).promise($);
				for (let m of response.userid) {
					let user = users.findItem('id', m);
					if (user)
						await FUNC.notify(response.id, m, 'user', $.user.name, user.name, null, m !== $.user.id);
				}
			}

			MAIN.ws && MAIN.ws.send({ TYPE: 'refresh', id: model.id }, filter);

			response.type = 'create';
			EMIT('ticket', response);

			$.success(model.id);
		}
	});

	schema.action('update', {
		name: 'Update ticket',
		input: 'userid:[String], *folderid:UID, *statusid:String, ownerid:String, *name:String, reference:String, estimate:Number, ispriority:Boolean, isbillable:Boolean, tags:[String], deadline:Date, attachments:[Object], date:Date',
		params: '*id:String',
		public: true,
		action: async function($, model) {

			var params = $.params;
			var keys = Object.keys(model);

			model.changed = 'metadata';
			model.dtupdated = NOW;

			if (model.name)
				model.search = model.name.toSearch();

			if (model.attachments)
				model.attachments = JSON.stringify(model.attachments);

			if (model.statusid)
				model.dtstatus = NOW;

			var userid = null;
			var tmp;

			if (model.userid) {
				model.changed = 'user';
				tmp = await DATA.read('tbl_ticket').fields('userid').id(params.id).where('isremoved=FALSE').error(404).promise($);
				userid = tmp.userid;
			} else if (model.statusid)
				model.changed = 'status';

			model.isprocessed = false;

			var response = await DATA.modify('tbl_ticket', model).error(404).id(params.id).where('isremoved=FALSE').returning(Returning).first().promise($);

			if (model.userid) {
				var newbie = [];
				for (let m of model.userid) {
					if (!userid.includes(m))
						newbie.push(m);
				}
				if (newbie.length) {
					var users = await DATA.find('tbl_user').fields('id,name').in('id', newbie).promise($);
					for (let m of response.userid) {
						for (let n of newbie) {
							let user = users.findItem('id', n);
							if (user)
								await FUNC.notify(response.id, m, 'user', $.user.name, user.name, null, m !== $.user.id);
						}
					}
				}
			} else if (model.statusid) {
				await FUNC.notify(response.id, response.ownerid, 'status', $.user.name, model.statusid, null, response.ownerid && response.ownerid !== $.user.id);
			} else {
				for (let m of response.userid)
					await FUNC.notify(response.id, m, 'metadata', $.user.name, keys.join(','), null, m !== $.user.id);
			}

			if (response.userid) {
				DATA.remove('tbl_ticket_unread').where('ticketid', params.id).notin('userid', response.userid);
				DATA.remove('tbl_notification').where('ticketid', params.id).notin('userid', response.userid);
			}

			var filter = client => response.ownerid === client.user.id || response.userid.includes(client.user.id);
			MAIN.ws && MAIN.ws.send({ TYPE: 'refresh', id: params.id }, filter);

			response.type = 'udpate';
			EMIT('ticket', response);

			$.success(params.id);
		}
	});

	schema.action('data_read', {
		name: 'Reads ticket data',
		params: '*id:String',
		public: true,
		action: function($) {
			var params = $.params;
			DATA.find('tbl_ticket_data').fields('id,widget,config').where('ticketid', params.id).sort('sortindex').callback($);
		}
	});

	schema.action('data_save', {
		name: 'Updates ticket data',
		input: '*clientid:String, data:[*id:String, *widget:String, newbie:Boolean, changed:Boolean, config:Object]',
		params: '*id:String',
		public: true,
		action: async function($, model) {

			var params = $.params;
			var ticket = await DATA.read('tbl_ticket').fields('userid,comments,changed').id(params.id).where('isremoved=FALSE').error(404).promise($);
			var nin = [];
			var changed = [];
			var types = {};
			var is = false;
			var comments = 0;

			for (var i = 0; i < model.data.length; i++) {

				var item = model.data[i];
				var insert = true;
				var modify = {};

				if (item.widget === 'comment')
					comments++;

				if (item.newbie || item.changed) {
					modify.id = item.id;
					modify.ticketid = params.id;
					modify.config = JSON.stringify(item.config);
					modify.dtupdated = NOW;
					modify.widget = item.widget;
					types[modify.widget] = 1;
					changed.push(item.id);
					is = true;
				} else {
					item.config = undefined;
					item.widget = undefined;
					insert = false;
				}

				item.newbie = undefined;
				item.changed = undefined;

				modify.sortindex = i + 1;

				nin.push(item.id);
				await DATA.modify('tbl_ticket_data', modify, insert).id(item.id).where('ticketid', params.id).promise($);
			}

			MAIN.ws && MAIN.ws.send({ TYPE: 'data', clientid: model.clientid, id: params.id, data: model.data });

			var builder = DATA.remove('tbl_ticket_data');
			builder.where('ticketid', params.id);
			nin.length && builder.notin('id', nin);
			await builder.promise($);

			var change = types.comment ? 'comment' : 'content';
			var currticket = await DATA.modify('tbl_ticket', { comments: comments, changed: change, dtupdated: NOW }).id(params.id).returning(Returning).first().promise($);

			if (is && (change == 'comment' || ticket.changed !== change)) {
				for (var m of ticket.userid)
					FUNC.notify(params.id, m, change, $.user.name, Object.keys(types).join(','), changed, m !== $.user.id);
			}

			currticket.type = change;
			EMIT('ticket', currticket);

			$.success();
		}
	});

	schema.action('clone', {
		name: 'Clone ticket',
		params: '*id:String',
		input: '*name:String,*folderid:UID,*date:Date,users:Boolean,status:Boolean',
		public: true,
		action: async function($, model) {

			var params = $.params;
			var item = await DATA.read('tbl_ticket').id(params.id).where('isremoved=FALSE').error(404).promise($);

			NOW = new Date();

			item.id = UID();

			if (item.deadline) {
				var diff = item.deadline - item.date;
				item.deadline = diff > 0 ? item.date.add(Math.round(diff / 1000 / 60 / 60 / 24) + ' days') : null;
			}

			item.search = item.name.toSearch();
			item.date = model.date || NOW;
			item.dtcreated = NOW;
			item.dtupdated = null;
			item.name = model.name;
			item.folderid = model.folderid;
			item.ownerid = $.user.id;
			item.isprocessed = false;

			if (!model.status)
				item.statusid = 'pending';

			if (!model.users)
				item.userid = [];

			var content = await DATA.find('tbl_ticket_data').where('ticketid', params.id).promise($);
			var response = await DATA.insert('tbl_ticket', item).returning(Returning).promise($);

			var contentid = Date.now().toString(36) + U.random_text(3);
			for (var i = 0; i < content.length; i++) {
				let m = content[i];
				m.id = contentid + 'X' + i;
				m.ticketid = item.id;
				m.dtupdated = NOW;
				await DATA.insert('tbl_ticket_data', m).promise($);
			}

			var filter = client => response.ownerid === client.user.id || response.userid.includes(client.user.id);

			for (var m of response.userid) {
				if (m !== $.user.id)
					await FUNC.notify(response.id, m, 'user', $.user.name);
			}

			MAIN.ws && MAIN.ws.send({ TYPE: 'refresh', id: item.id }, filter);

			response.type = 'clone';
			EMIT('ticket', response);

			$.success(item.id);
		}
	});

	schema.action('logs', {
		name: 'Ticket logs',
		params: '*id:String',
		public: true,
		action: function($) {
			var params = $.params;
			DATA.find('view_ticket_time').fields('id,user_name,name,dtcreated,minutes').where('ticketid', params.id).sort('dtcreated', true).callback($);
		}
	});

	schema.action('remove', {
		name: 'Remove ticket',
		params: '*id:String',
		public: true,
		action: function($) {

			if (UNAUTHORIZED($, 'tickets_remove', 'admin'))
				return;

			var params = $.params;
			DATA.modify('tbl_ticket', { isremoved: true, dtremoved: NOW }).id(params.id).error(404).callback($.done(params.id));
			DATA.remove('tbl_ticket_unread').where('ticketid', params.id);
			DATA.remove('tbl_ticket_bookmark').where('ticketid', params.id);
			DATA.remove('tbl_notification').where('ticketid', params.id);

			var obj = {};
			obj.id = params.id;
			obj.type = 'remove';
			EMIT('ticket', obj);
		}
	});

	schema.action('logwork_start', {
		name: 'Start logwork timer',
		input: '*ticketid:String',
		action: async function($, model) {

			var ticket = await DATA.read('tbl_ticket').fields('statusid').id(model.ticketid).where('isremoved=FALSE').error(404).promise($);
			if (ticket.statusid === 'pending') {
				// change status to "open"
				await $.action('#update', { statusid: 'open' }).params({ id: model.ticketid }).user($.user).promise($);
			}

			NOW = new Date();
			model.id = UID();
			model.userid = $.user.id;
			model.dtcreated = NOW;
			model.date = NOW;
			model.start = NOW;

			await DATA.insert('tbl_ticket_time', model).promise($);
			$.success(model.id);
		}
	});

	schema.action('logwork_open', {
		name: 'Open timers',
		action: function($) {
			DATA.query('SELECT a.id, a.ticketid, b.name, a.start FROM tbl_ticket_time a LEFT JOIN tbl_ticket b ON b.id=a.ticketid WHERE a.userid=\'{0}\' AND start IS NOT NULL ORDER BY a.start'.format($.user.id)).callback($);
		}
	});

	schema.action('logwork_stop', {
		name: 'Stop logwork timer',
		input: '*id:String',
		action: async function($, model) {

			var item = await DATA.read('tbl_ticket_time').fields('ticketid,start').id(model.id).where('userid', $.user.id).where('start IS NOT NULL').error('@(Timer not found)').promise($);
			var diff = Math.ceil((Date.now() - item.start) / 1000 / 60);
			var limit = 60 * 8; // Max. 8 hours
			var config = MAIN.db.config;

			if (diff > limit)
				diff = limit;

			if (diff < config.minlogtime)
				diff = config.minlogtime;

			await DATA.modify('tbl_ticket_time', { '+minutes': diff, start: null }).id(model.id).promise($);
			await DATA.modify('tbl_ticket', { '+worked': diff }).id(item.ticketid).promise($);

			var ticket = await DATA.read('tbl_ticket').fields('userid,worked').id(item.ticketid).promise($);
			$.callback({ id: item.ticketid, worked: ticket.worked });

			for (var m of ticket.userid) {
				if (m !== $.user.id)
					FUNC.notify(item.ticketid, m, 'logwork', $.user.name, diff + '');
			}

		}
	});

	schema.action('logwork_create', {
		name: 'Logwork',
		input: '*ticketid:String, *minutes:Number, name:String, *date:Date',
		public: true,
		action: async function($, model) {

			var config = MAIN.db.config;

			model.id = UID();
			model.userid = $.user.id;
			model.dtcreated = NOW;

			if (model.minutes < config.minlogtime)
				model.minutes = config.minlogtime;

			await DATA.modify('tbl_ticket', { '+worked': model.minutes }).id(model.ticketid).error('@(Ticket not found)').promise($);
			await DATA.insert('tbl_ticket_time', model).promise($);

			var ticket = await DATA.read('tbl_ticket').fields('userid,worked').id(model.ticketid).promise($);
			$.success(ticket.worked);

			for (var m of ticket.userid) {
				if (m !== $.user.id)
					FUNC.notify(model.ticketid, m, 'logwork', $.user.name, model.minutes + '');
			}

		}
	});

	schema.action('logwork_update', {
		name: 'Update time',
		input: '*minutes:Number, name:String, *date:Date',
		params: '*id:String',
		action: async function($, model) {

			var params = $.params;
			var config = MAIN.db.config;

			if (model.minutes < config.minlogtime)
				model.minutes = config.minlogtime;

			var response = await DATA.modify('tbl_ticket_time', model).id(params.id).error('@(Log not found)').returning('ticketid').first().promise($);
			await DATA.query('UPDATE tbl_ticket a SET worked=(SELECT SUM(x.minutes) FROM tbl_ticket_time x WHERE x.ticketid=a.id) WHERE a.id=' + PG_ESCAPE(response.ticketid));
			var ticket = await DATA.read('tbl_ticket').fields('worked').id(response.ticketid).promise($);
			$.success(ticket.worked);
		}
	});

	schema.action('logwork_remove', {
		name: 'Remove time',
		params: '*id:String',
		action: async function($) {
			var params = $.params;
			var response = await DATA.remove('tbl_ticket_time').id(params.id).error('@(Log not found)').returning('ticketid').first().promise($);
			await DATA.query('UPDATE tbl_ticket a SET worked=(SELECT SUM(x.minutes) FROM tbl_ticket_time x WHERE x.ticketid=a.id) WHERE a.id=' + PG_ESCAPE(response.ticketid));
			var ticket = await DATA.read('tbl_ticket').fields('worked').id(response.ticketid).promise($);
			$.success(ticket.worked);
		}
	});

	schema.action('history', {
		name: 'Read all notifications + set unread to read',
		params: '*id:String',
		action: async function($) {

			var params = $.params;
			var items = await DATA.find('tbl_notification').fields('typeid,createdby,value,isunread,dtcreated').where('ticketid', params.id).where('userid', $.user.id).sort('dtcreated', true).promise($);

			for (var m of items) {
				if (m.isunread) {
					DATA.modify('tbl_notification', { isunread: false, dtread: NOW }).where('userid', $.user.id).where('isunread=TRUE');
					break;
				}
			}

			$.callback(items);
		}
	});

	schema.action('bookmark', {
		name: 'Toggle bookmark',
		params: '*id:String',
		input: 'type:{create|remove|check}',
		action: async function($, model) {
			var params = $.params;
			var id = params.id + $.user.id;
			var bookmark = await DATA.read('tbl_ticket_bookmark').id(id).promise($);
			var output = {};

			switch (model.type) {
				case 'create':
					if (!bookmark)
						await DATA.insert('tbl_ticket_bookmark', { id: id, ticketid: params.id, userid: $.user.id }).promise($);
					output.is = true;
					break;
				case 'remove':
					if (bookmark)
						await DATA.remove('tbl_ticket_bookmark').id(id).promise($);
					output.is = false;
					break;
				default:
					output.is = bookmark ? true : false;
					break;
			}

			$.callback(output);
		}
	});

	schema.action('unread', {
		name: 'Unread counter',
		action: function($) {
			DATA.count('tbl_ticket_unread').where('userid', $.user.id).where('isunread=TRUE AND EXISTS(SELECT 1 FROM tbl_ticket x WHERE x.isremoved=FALSE AND x.id=tbl_ticket_unread.id AND x.date<=timezone(\'utc\'::text, now()))').callback($);
		}
	});

	schema.action('reset', {
		name: 'Reset unread state',
		params: '*id:String',
		action: function($) {
			var params = $.params;
			DATA.modify('tbl_ticket_unread', { isunread: false }).id(params.id + $.user.id).error(404).callback($.done(params.id));
		}
	});

	schema.action('counter', {
		name: 'Get counts from tickets',
		action: function($) {
			var builder = 'SELECT ';
			builder += '(SELECT COUNT(1)::int4 FROM tbl_ticket_unread a INNER JOIN tbl_ticket b ON b.id=a.ticketid AND b.isremoved=FALSE AND b.date<=timezone(\'utc\'::text, now()) WHERE a.userid={0} AND a.isunread=TRUE) AS unread,';
			builder += '(SELECT COUNT(1)::int4 FROM tbl_ticket WHERE statusid=\'review\' AND ownerid={0} AND isremoved=FALSE) AS review,';
			builder += '(SELECT COUNT(1)::int4 FROM tbl_ticket WHERE statusid=\'pending\' AND {0}=ANY(userid) AND isremoved=FALSE AND date<=timezone(\'utc\'::text, now()) AND folderid IN (SELECT x.id FROM tbl_folder x WHERE x.isprivate=FALSE AND x.isarchived=FALSE)) AS pending,';
			builder += '(SELECT COUNT(1)::int4 FROM tbl_ticket WHERE statusid=\'open\' AND {0}=ANY(userid) AND isremoved=FALSE AND date<=timezone(\'utc\'::text, now()) AND folderid IN (SELECT x.id FROM tbl_folder x WHERE x.isprivate=FALSE AND x.isarchived=FALSE)) AS open,';
			builder += '(SELECT COUNT(1)::int4 FROM tbl_ticket WHERE {0}=ANY(userid) AND isremoved=FALSE AND id IN (SELECT x.ticketid FROM tbl_ticket_bookmark x WHERE x.userid={0})) AS bookmarks';
			DATA.query(builder.format(PG_ESCAPE($.user.id))).first().callback($);
		}
	});

	schema.action('link', {
		name: 'Link with another ticket',
		input: '*ticketid:String, *type:{add|rem}',
		params: '*id:String',
		action: async function($, model) {

			var params = $.params;

			if (params.id === model.ticketid) {
				$.invalid("@(The ticket can't be assigned to itself)");
				return;
			}

			var ticket = await DATA.read('tbl_ticket').fields('userid,ownerid').id(params.id).error('@(Ticket not found)').promise($);

			if (model.type === 'add') {
				await DATA.modify('tbl_ticket', { parentid: params.id, dtparent: NOW }).id(model.ticketid).promise($);
			} else {
				await DATA.modify('tbl_ticket', { parentid: null, dtparent: null }).id(model.ticketid).where('parentid', params.id).promise($);
			}

			var filter = client => ticket.ownerid === client.user.id || ticket.userid.includes(client.user.id);
			MAIN.ws && MAIN.ws.send({ TYPE: 'refresh', id: params.id }, filter);
			$.success();

		}
	});

	schema.action('links', {
		name: 'Links list',
		params: '*id:String',
		action: async function($) {

			var fields = 'id,name,statusid,userid,dtparent,worked';
			var params = $.params;
			var item = await DATA.read('tbl_ticket').fields('parentid').id(params.id).where('isremoved=FALSE').error(404).promise($);
			var response = await DATA.find('tbl_ticket').fields(fields).where('parentid', params.id).sort('dtparent').where('isremoved=FALSE').promise($);

			if (item.parentid) {
				var parent = await DATA.read('tbl_ticket').fields(fields).id(item.parentid).promise($);
				parent.type = 'child';
				response.push(parent);
			}

			$.callback(response);

		}
	});

});