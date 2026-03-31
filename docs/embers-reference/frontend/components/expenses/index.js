import React, { Component } from 'react';
import { connect } from 'react-redux';
import { Row, Col } from 'react-bootstrap';
import { parseBool } from '../../services/address';
import {
  Table,
  TableBody,
  TableHeader,
  TableHeaderColumn,
  TableRow,
  TableRowColumn,
  RaisedButton,
  FlatButton,
  Dialog,
  IconButton,
  Paper,
  CircularProgress,
  Avatar,
  FloatingActionButton
} from 'material-ui';
import {
  ActionVisibility,
  ActionVisibilityOff,
  ImageEdit,
  ActionDelete,
  ContentAdd,
  NavigationRefresh
} from 'material-ui/svg-icons';
import Select from 'rc-select';
import Pagination from 'rc-pagination';
import pt_PT from 'rc-pagination/lib/locale/pt_PT';
import SortingTh from '../common/sorting_th';
import Filters from '../common/filters_component';
import { paperStyle } from '../common/styles';
import { all, destroy, undestroy } from '../../services/expense';
import BrasumeLogoIcon from '../common/icons/bitemberlogo';

class Expenses extends Component {
  state = {
    filters: {
      page: 1,
      per_page: 10,
      card: '',
      entity: '',
      date: '',
      category: '',
      show_all: false,
      show_all_disabled: false,
      show_week: false,
      show_week_disabled: false,
    },
    expenses: [],
    count: 0,
    total: 0.0,
    score: 0,
    showConfirm: false,
    isLoadingBalances: false
  };

  componentWillMount() {
    this._retrieveExpenses();
  }

  _retrieveExpenses = () => {
    const { filters } = this.state;
    all(filters).success(res => {
      this.setState({
        expenses: res.expenses,
        total: res.total,
        score: res.score,
        count: res.count
      })
    })
  };

  handlePageChange = (page) => {
    this.setState({filters: {...this.state.filters, page}}, this._retrieveExpenses);
  };

  handleShowSizeChange = (_,per_page) => {
    this.setState({filters: {...this.state.filters, page: 1, per_page}}, this._retrieveExpenses);
  };

  prepareToDestroy = record => {
    this.setState({
      selectedRecord: record,
      showConfirm: true
    })
    console.log("Preparing to delete the id: " + record.id);
  };

  updateFilters = (filters = []) => {
    let hash = {};
    filters.forEach(item => Object.keys(item).forEach(key => hash[key] = item[key]));

  // Mutually exclusive behavior for show_all and show_week
  if (hash.show_all) {
    hash.show_all = parseBool(hash.show_all);
    hash.show_week = false;
    hash.show_week_disabled = true;
  } else if (hash.show_week) {
    hash.show_week = parseBool(hash.show_week);
    hash.show_all = false;
    hash.show_all_disabled = true;
  } else {
    hash.show_all_disabled = false;
    hash.show_week_disabled = false;
  }

    console.log("FIlter show week: " + hash.show_week);
    console.log("FIlter show all: " + hash.show_all);


    this.setState({
      filters: {
        ...this.state.filters,
        //show_all: hash.show_all,
        //show_week: hash.show_week,
        ...hash,
        page: 1
      }
    }, this._retrieveExpenses)
  };

  closeConfirm = () => {
    this.setState({ showConfirm: false })
  };

  handleDelete = () => {
    const { selectedRecord } = this.state;
    destroy(selectedRecord.id).success(res => {
      this._retrieveExpenses();
      this.closeConfirm();
    });
  };

  handleSoftDelete = () => {
    const { selectedRecord } = this.state;
    destroy(selectedRecord.id).success(res => {
      this._retrieveExpenses();
      this.closeConfirm();
    });
  };

  handleUndestroy = (id) => {
    undestroy(id).success(res => {
      this._retrieveExpenses();
      console.log('Expense is counting again. ', res);
    });
  }

  dateFormatter = ({ isoDate }) => {
    // Converte o ISO 8601 para um objeto Date
    const date = new Date(isoDate);
  
    // Configura o formatador de data e hora para português (Portugal)
    const formattedDate = new Intl.DateTimeFormat('pt-PT', {
      day: '2-digit',       // Exibe o dia com dois dígitos (exemplo: 06)
      month: 'long',        // Exibe o mês por extenso (exemplo: dezembro)
      year: 'numeric',      // Exibe o ano completo (exemplo: 2024)
      hour: '2-digit',      // Exibe a hora com dois dígitos (exemplo: 14)
      minute: '2-digit',    // Exibe os minutos com dois dígitos (exemplo: 30)
      timeZone: 'Europe/Lisbon', // Garante o horário correto
    }).format(date);
  
    return <div>{formattedDate}</div>;
  };
  
  

  render() {
    const { isLoading } = this.props.app.main;
    const { expenses, showConfirm, count, total, score } = this.state;
    const { page, per_page, show_all_disabled, show_week_disabled } = this.state.filters;
    const { palette } = this.context.muiTheme;

    return (
      <div>
        <Row>
          <Col sm={12}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <h2 style={{ margin: '0', display: 'flex', alignItems: 'center' }}>
                  <BrasumeLogoIcon />
                  Expenses ({total ? total.toFixed(2) : '0.00'} EUR)
                <FloatingActionButton
                  disabled={isLoading}
                  mini={true}
                  onClick={this._retrieveExpenses}
                  style={{ marginLeft: '10px' }}
                >
                  <NavigationRefresh />
                </FloatingActionButton>
                </h2>
              </div>
              <h3 style={{ margin: '0', marginLeft: '50px', marginBottom: '20px' }}>You have a week score of {score}/10</h3>
            </div>
          </Col>
        </Row>

        <Row>
          <Col sm={8}>
            <Pagination
              selectComponentClass={Select}
              onChange={this.handlePageChange}
              showQuickJumper={true}
              showSizeChanger={true}
              pageSizeOptions={['10','20','50']}
              pageSize={per_page}
              onShowSizeChange={this.handleShowSizeChange}
              current={page}
              total={count}
              locale={pt_PT}
            />
          </Col>
          <Col sm={4} className="text-right" style={{minHeight:61}}>
            <CircularProgress className={isLoading ? 'loading-spinner' : 'hidden'} size={36} />
            <FloatingActionButton style={{marginRight: 20}} mini={true} href={`#/expense/new`} 
            ><ContentAdd/></FloatingActionButton>
          </Col>
        </Row>
        <Filters columns={[
          {label: 'Entity/Place', key: 'entity', type: 'string'},
          {label: 'Date', key: 'date', type: 'string'},
          {label: 'Card', key: 'card', type: 'string'},
          {label: 'Category', key: 'category', type: 'string'},
          {label: 'Show All', key: 'show_all', type: 'toggle', disabled: show_all_disabled},
          {label: 'Only this Week', key: 'show_week', type: 'toggle', disabled: show_week_disabled}
        ]} update={this.updateFilters}/>
        <hr/>
        <Table>
          <TableHeader displaySelectAll={false} adjustForCheckbox={false}>
            <TableRow>
              <TableHeaderColumn style={{ width: '100px' }}>Category</TableHeaderColumn>
              <TableHeaderColumn><SortingTh update={this.updateFilters} column='entity'>Entity</SortingTh></TableHeaderColumn>
              <TableHeaderColumn>Amount</TableHeaderColumn>
              <TableHeaderColumn><SortingTh update={this.updateFilters} column='date'>Date</SortingTh></TableHeaderColumn>
              <TableHeaderColumn style={{ width: '350px' }}>Actions</TableHeaderColumn>

            </TableRow>
          </TableHeader>
          <TableBody displayRowCheckbox={false}>
            {
              expenses.map(item => {
                return (
                  <TableRow key={item.id}>
                    <TableRowColumn style={{ width: '100px' }}><Avatar src={item.category_icon || ''} size={30}/></TableRowColumn>
                    <TableRowColumn>{ item.entity }</TableRowColumn>
                    <TableRowColumn>{parseFloat(item.amount).toFixed(2)} EUR</TableRowColumn>
                    <TableRowColumn>{this.dateFormatter({ isoDate: item.date })}</TableRowColumn>
                    <TableRowColumn className='text-right' style={{ width: '350px' }}>
                      <IconButton onTouchTap={() => location.hash = `#/expense/${item.id}`}><ActionVisibility color={palette.primary1Color} /></IconButton>
                      <IconButton onTouchTap={() => location.hash = `#/expense/${item.id}/edit`}><ImageEdit color={palette.accent1Color} /></IconButton>
                      {item.show ? ( // Verifica se a propriedade show é true
                        // Mostra o botão para preparar para destruir
                        <IconButton onTouchTap={this.prepareToDestroy.bind(this,item)}><ActionVisibilityOff color="#c62828" /></IconButton>
                      ) : (
                        // Mostra outro ícone/botão e chama a função undestroy
                        <IconButton onTouchTap={() => this.handleUndestroy(item.id)}><ActionVisibility color="#c62828" /></IconButton>
                      )}
                        <IconButton onTouchTap={this.prepareToDestroy.bind(this,item)}><ActionDelete color="#c62828" /></IconButton>
                    </TableRowColumn>
                  </TableRow>
                )
              })
            }
          </TableBody>
        </Table>
        <Dialog
          title="Are you sure?"
          actions={[
            <FlatButton onTouchTap={this.closeConfirm} label='Cancel'/>,
            <FlatButton secondary={true} onTouchTap={this.handleDelete} label='Confirm' />
          ]}
          modal={false}
          open={showConfirm}
          onRequestClose={this.closeConfirm}
        >
          You are going to remove an expense from your view
        </Dialog>
      </div>
    )
  }
}

Expenses.contextTypes = {
  muiTheme: React.PropTypes.object.isRequired
};

export default connect(state => state)(Expenses)
